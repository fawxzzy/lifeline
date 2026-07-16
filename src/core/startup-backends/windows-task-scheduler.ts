import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLifelineRoot } from "../lifeline-root.js";
import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

export const WINDOWS_STARTUP_TASK_NAME = "LifelineRestoreAtLogon";
const TASK_MECHANISM = "windows-task-scheduler";
const TASK_AUTHOR = "Lifeline";
const TASK_URI = `\\${WINDOWS_STARTUP_TASK_NAME}`;
const TASK_DEFINITION_VERSION = 4;

interface SchedulerCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type WindowsSchedulerRunner = (
  args: string[],
) => Promise<SchedulerCommandResult>;

export interface WindowsStartupIdentity {
  account: string;
  sid: string;
}

export interface WindowsTaskSchedulerOptions {
  rootDirectory?: string;
  nodeExecutable?: string;
  cliEntrypoint?: string;
  identity?: WindowsStartupIdentity;
}

interface LauncherPlan {
  sourceDirectory: string;
  sourceHash: string;
  launcherDirectory: string;
  launcherEntrypoint: string;
  launcherMetadataPath: string;
  taskDefinitionPath: string;
  rollbackDefinitionPath: string;
}

interface ExpectedTaskDefinition {
  rootDirectory: string;
  identity: WindowsStartupIdentity;
  nodeExecutable: string;
  arguments: string;
  workingDirectory: string;
  description: string;
  xml: string;
  launcher: LauncherPlan;
}

type DetailedTaskState =
  | "absent"
  | "installed"
  | "owned-drift"
  | "conflict"
  | "error"
  | "unsupported";

interface DetailedTaskInspection {
  state: DetailedTaskState;
  detail: string;
  expected?: ExpectedTaskDefinition;
  existingXml?: string;
}

function normalizeOutput(value: string): string {
  return value.trim();
}

async function runCommand(
  command: string,
  args: string[],
): Promise<SchedulerCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolve({
        code: -1,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(
          `Unable to execute ${command}: ${error.message}`,
        ),
      });
    });

    child.on("exit", (code: number | null) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(stderr),
      });
    });
  });
}

function runSchtasks(args: string[]): Promise<SchedulerCommandResult> {
  return runCommand("schtasks.exe", args);
}

function parseWhoamiCsv(raw: string): WindowsStartupIdentity | undefined {
  const match = raw.trim().match(/^"((?:[^"]|"")*)","(S-[0-9-]+)"/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    account: match[1].replaceAll('""', '"'),
    sid: match[2],
  };
}

async function resolveCurrentIdentity(): Promise<WindowsStartupIdentity> {
  const result = await runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const identity =
    result.code === 0 ? parseWhoamiCsv(result.stdout) : undefined;
  if (!identity) {
    throw new Error(
      `Could not resolve the current Windows user identity: ${
        result.stderr || result.stdout || "whoami returned no usable identity"
      }`,
    );
  }
  return identity;
}

function normalizeComparablePath(value: string): string {
  return path.normalize(value).toLowerCase();
}

function matchesExpectedIdentity(
  value: string,
  expected: WindowsStartupIdentity,
): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === expected.sid.toLowerCase() ||
    normalized === expected.account.toLowerCase()
  );
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDecode(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function sectionValue(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match?.[1] ?? "";
}

function tagValue(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return xmlDecode(match?.[1]?.trim() ?? "");
}

function countOpeningTags(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"))?.length ?? 0;
}

interface FlatXmlChild {
  attributes: string;
  value: string;
}

function parseFlatXmlChildren(
  xml: string,
): Map<string, FlatXmlChild> | undefined {
  const children = new Map<string, FlatXmlChild>();
  const childPattern = /<([A-Za-z][A-Za-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  for (const match of xml.matchAll(childPattern)) {
    const index = match.index ?? -1;
    const tag = match[1];
    if (
      index < cursor ||
      xml.slice(cursor, index).trim() !== "" ||
      !tag ||
      children.has(tag)
    ) {
      return undefined;
    }
    children.set(tag, {
      attributes: match[2] ?? "",
      value: match[3] ?? "",
    });
    cursor = index + match[0].length;
  }
  return xml.slice(cursor).trim() === "" ? children : undefined;
}

function tagHasNoAttributes(xml: string, tag: string): boolean {
  const matches = [...xml.matchAll(new RegExp(`<${tag}([^>]*)>`, "gi"))];
  return matches.length === 1 && (matches[0]?.[1] ?? "").trim() === "";
}

function tagAttributeValue(
  xml: string,
  tag: string,
  attribute: string,
): string {
  const openingTag = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "i"))?.[0];
  const value = openingTag?.match(
    new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "i"),
  )?.[1];
  return xmlDecode(value ?? "");
}

function parseXmlAttributes(
  rawAttributes: string,
): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  const attributePattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let cursor = 0;
  for (const match of rawAttributes.matchAll(attributePattern)) {
    const index = match.index ?? -1;
    const name = match[1];
    if (
      index < cursor ||
      rawAttributes.slice(cursor, index).trim() !== "" ||
      !name ||
      attributes.has(name)
    ) {
      return undefined;
    }
    attributes.set(name, xmlDecode(match[2] ?? ""));
    cursor = index + match[0].length;
  }
  return rawAttributes.slice(cursor).trim() === "" ? attributes : undefined;
}

function expectedLogonTrigger(
  xml: string,
  identity: WindowsStartupIdentity,
): boolean {
  if (
    countOpeningTags(xml, "Triggers") !== 1 ||
    !tagHasNoAttributes(xml, "Triggers")
  ) {
    return false;
  }
  const triggers = parseFlatXmlChildren(sectionValue(xml, "Triggers"));
  const logonTrigger = triggers?.get("LogonTrigger");
  if (
    triggers?.size !== 1 ||
    !logonTrigger ||
    logonTrigger.attributes.trim() !== ""
  ) {
    return false;
  }

  const children = parseFlatXmlChildren(logonTrigger.value);
  const enabled = children?.get("Enabled");
  return (
    (children?.size === 1 || children?.size === 2) &&
    [...children.keys()].every(
      (tag) => tag === "Enabled" || tag === "UserId",
    ) &&
    children.get("UserId")?.attributes.trim() === "" &&
    matchesExpectedIdentity(
      xmlDecode(children.get("UserId")?.value.trim() ?? ""),
      identity,
    ) &&
    (enabled === undefined ||
      (enabled.attributes.trim() === "" &&
        xmlDecode(enabled.value.trim()) === "true"))
  );
}

function expectedPrincipal(
  xml: string,
  identity: WindowsStartupIdentity,
): boolean {
  if (
    countOpeningTags(xml, "Principals") !== 1 ||
    !tagHasNoAttributes(xml, "Principals")
  ) {
    return false;
  }
  const principals = parseFlatXmlChildren(sectionValue(xml, "Principals"));
  const principal = principals?.get("Principal");
  const principalAttributes = principal
    ? parseXmlAttributes(principal.attributes)
    : undefined;
  if (
    principals?.size !== 1 ||
    !principal ||
    principalAttributes?.size !== 1 ||
    principalAttributes.get("id") !== "Author"
  ) {
    return false;
  }

  const children = parseFlatXmlChildren(principal.value);
  const runLevel = children?.get("RunLevel");
  return (
    (children?.size === 2 || children?.size === 3) &&
    [...children.keys()].every(
      (tag) => tag === "UserId" || tag === "LogonType" || tag === "RunLevel",
    ) &&
    children.get("UserId")?.attributes.trim() === "" &&
    matchesExpectedIdentity(
      xmlDecode(children.get("UserId")?.value.trim() ?? ""),
      identity,
    ) &&
    children.get("LogonType")?.attributes.trim() === "" &&
    xmlDecode(children.get("LogonType")?.value.trim() ?? "") ===
      "InteractiveToken" &&
    (runLevel === undefined ||
      (runLevel.attributes.trim() === "" &&
        xmlDecode(runLevel.value.trim()) === "LeastPrivilege"))
  );
}

function singleExecAction(xml: string): string | undefined {
  if (
    countOpeningTags(xml, "Actions") !== 1 ||
    tagAttributeValue(xml, "Actions", "Context") !== "Author"
  ) {
    return undefined;
  }
  const actions = sectionValue(xml, "Actions");
  const execBlocks =
    actions.match(/<Exec(?:\s[^>]*)?>[\s\S]*?<\/Exec>/gi) ?? [];
  if (
    execBlocks.length !== 1 ||
    actions.replace(execBlocks[0] ?? "", "").trim() !== ""
  ) {
    return undefined;
  }
  return sectionValue(execBlocks[0] ?? "", "Exec");
}

function matchesRequiredTaskSettings(settings: string): boolean {
  const expectedValues = new Map<string, string>([
    ["DisallowStartIfOnBatteries", "false"],
    ["StopIfGoingOnBatteries", "false"],
    ["ExecutionTimeLimit", "PT0S"],
    ["MultipleInstancesPolicy", "IgnoreNew"],
    ["StartWhenAvailable", "true"],
    ["UseUnifiedSchedulingEngine", "true"],
  ]);
  const children = parseFlatXmlChildren(settings);
  if (!children || children.size !== expectedValues.size + 1) {
    return false;
  }
  for (const [tag, expected] of expectedValues) {
    const child = children.get(tag);
    if (
      !child ||
      child.attributes.trim() !== "" ||
      xmlDecode(child.value.trim()) !== expected
    ) {
      return false;
    }
  }

  const idleSettings = children.get("IdleSettings");
  if (!idleSettings || idleSettings.attributes.trim() !== "") {
    return false;
  }
  const idleChildren = parseFlatXmlChildren(idleSettings.value);
  return (
    idleChildren?.size === 2 &&
    idleChildren.get("StopOnIdleEnd")?.attributes.trim() === "" &&
    xmlDecode(idleChildren.get("StopOnIdleEnd")?.value.trim() ?? "") ===
      "false" &&
    idleChildren.get("RestartOnIdle")?.attributes.trim() === "" &&
    xmlDecode(idleChildren.get("RestartOnIdle")?.value.trim() ?? "") === "false"
  );
}

function isTaskMissing(result: SchedulerCommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("cannot find") ||
    combined.includes("could not find") ||
    combined.includes("task not found") ||
    combined.includes("system cannot find the file")
  );
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const absolutePath = path.join(directory, name);
    if (typeof entry !== "string" && entry.isDirectory()) {
      files.push(...(await listFilesRecursively(absolutePath)));
    } else {
      files.push(absolutePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function isLauncherMetadataFile(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/") === "launcher.json";
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFilesRecursively(directory);
  for (const file of files) {
    const relativePath = path.relative(directory, file).replaceAll("\\", "/");
    if (isLauncherMetadataFile(relativePath)) {
      continue;
    }
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(file, "utf8"), "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function listRelativeFiles(directory: string): Promise<string[]> {
  return (await listFilesRecursively(directory)).map((file) =>
    path.relative(directory, file).replaceAll("\\", "/"),
  );
}

async function listLauncherPayloadFiles(directory: string): Promise<string[]> {
  return (await listRelativeFiles(directory)).filter(
    (file) => !isLauncherMetadataFile(file),
  );
}

async function copyLauncherPayload(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const relativeFile of await listLauncherPayloadFiles(source)) {
    const sourcePath = path.join(source, relativeFile);
    const destinationPath = path.join(destination, relativeFile);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

async function filesHaveSameBytes(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    readFile(leftPath),
    readFile(rightPath),
  ]).catch(() => [undefined, undefined] as const);
  if (!left || !right || left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

async function launcherSnapshotMatches(
  launcher: LauncherPlan,
  expectedMetadata: string,
): Promise<boolean> {
  const existingMetadata = await readFile(
    launcher.launcherMetadataPath,
    "utf8",
  ).catch(() => "");
  if (existingMetadata !== expectedMetadata) {
    return false;
  }

  const sourceFiles = await listLauncherPayloadFiles(launcher.sourceDirectory);
  const launcherFiles = await listLauncherPayloadFiles(
    launcher.launcherDirectory,
  ).catch(() => []);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(launcherFiles)) {
    return false;
  }

  for (const relativeFile of sourceFiles) {
    if (
      !(await filesHaveSameBytes(
        path.join(launcher.sourceDirectory, relativeFile),
        path.join(launcher.launcherDirectory, relativeFile),
      ))
    ) {
      return false;
    }
  }
  return true;
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !relative.startsWith("..\\") &&
      !path.isAbsolute(relative))
  );
}

async function buildLauncherPlan(
  rootDirectory: string,
  cliEntrypoint: string,
): Promise<LauncherPlan> {
  const sourceDirectory = path.dirname(cliEntrypoint);
  if (isSameOrDescendantPath(rootDirectory, sourceDirectory)) {
    throw new Error(
      `Windows startup root ${rootDirectory} must not be the launcher source directory ${sourceDirectory} or one of its descendants.`,
    );
  }
  const sourceHash = await hashDirectory(sourceDirectory);
  const sourceMetadata = await readFile(
    path.join(sourceDirectory, "launcher.json"),
    "utf8",
  ).catch(() => "");
  if (
    sourceMetadata &&
    sourceMetadata !==
      `${JSON.stringify({ version: 1, sourceHash }, null, 2)}\n`
  ) {
    throw new Error(
      `Windows startup launcher source metadata does not match payload bytes at ${sourceDirectory}.`,
    );
  }
  const startupDirectory = path.join(
    rootDirectory,
    ".lifeline",
    "startup",
    "windows",
  );
  const launcherDirectory = path.join(
    startupDirectory,
    `launcher-${sourceHash.slice(0, 16)}`,
  );
  const sourceIsLauncherDirectory =
    path.relative(sourceDirectory, launcherDirectory) === "";
  if (
    !sourceIsLauncherDirectory &&
    (isSameOrDescendantPath(launcherDirectory, sourceDirectory) ||
      isSameOrDescendantPath(sourceDirectory, launcherDirectory))
  ) {
    throw new Error(
      `Windows startup launcher destination ${launcherDirectory} must not overlap launcher source ${sourceDirectory}.`,
    );
  }
  return {
    sourceDirectory,
    sourceHash,
    launcherDirectory,
    launcherEntrypoint: path.join(launcherDirectory, "cli.js"),
    launcherMetadataPath: path.join(launcherDirectory, "launcher.json"),
    taskDefinitionPath: path.join(startupDirectory, "task-definition.xml"),
    rollbackDefinitionPath: path.join(
      startupDirectory,
      "task-definition.rollback.xml",
    ),
  };
}

function buildTaskXml(expected: Omit<ExpectedTaskDefinition, "xml">): string {
  const fields = {
    author: xmlEscape(TASK_AUTHOR),
    description: xmlEscape(expected.description),
    uri: xmlEscape(TASK_URI),
    userId: xmlEscape(expected.identity.sid),
    command: xmlEscape(expected.nodeExecutable),
    arguments: xmlEscape(expected.arguments),
    workingDirectory: xmlEscape(expected.workingDirectory),
  };

  return `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${fields.author}</Author>
    <Description>${fields.description}</Description>
    <URI>${fields.uri}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${fields.userId}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${fields.userId}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${fields.command}</Command>
      <Arguments>${fields.arguments}</Arguments>
      <WorkingDirectory>${fields.workingDirectory}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function buildExpectedTaskDefinition(
  options: WindowsTaskSchedulerOptions,
): Promise<ExpectedTaskDefinition> {
  const rootDirectory = path.resolve(
    options.rootDirectory ?? getLifelineRoot(),
  );
  const nodeExecutable = path.resolve(
    options.nodeExecutable ?? process.execPath,
  );
  const cliEntrypoint = path.resolve(
    options.cliEntrypoint ??
      fileURLToPath(new URL("../../cli.js", import.meta.url)),
  );
  const identity = options.identity ?? (await resolveCurrentIdentity());
  const launcher = await buildLauncherPlan(rootDirectory, cliEntrypoint);

  if (
    rootDirectory.includes('"') ||
    launcher.launcherEntrypoint.includes('"')
  ) {
    throw new Error("Windows startup paths must not contain quote characters.");
  }

  const description = `Managed by Lifeline Windows startup v${TASK_DEFINITION_VERSION}. Root: ${rootDirectory}`;
  const argumentsValue = `"${launcher.launcherEntrypoint}" --root "${rootDirectory}" restore --startup`;
  const expectedWithoutXml = {
    rootDirectory,
    identity,
    nodeExecutable,
    arguments: argumentsValue,
    workingDirectory: rootDirectory,
    description,
    launcher,
  };

  return {
    ...expectedWithoutXml,
    xml: buildTaskXml(expectedWithoutXml),
  };
}

function isLifelineOwnedTask(
  xml: string,
  expected: ExpectedTaskDefinition,
): boolean {
  const registrationInfo = sectionValue(xml, "RegistrationInfo");
  const action = singleExecAction(xml);
  if (
    !action ||
    !expectedLogonTrigger(xml, expected.identity) ||
    !expectedPrincipal(xml, expected.identity)
  ) {
    return false;
  }
  const description = tagValue(registrationInfo, "Description");
  const descriptionMatch = description.match(
    /^Managed by Lifeline Windows startup v([0-9]+)\. Root: (.+)$/,
  );
  const version = Number(descriptionMatch?.[1]);
  const describedRoot = descriptionMatch?.[2] ?? "";
  const argumentsMatch = tagValue(action, "Arguments").match(
    /^"([^"]+)" --root "([^"]+)" restore( --startup)?$/,
  );
  const launcherEntrypoint = argumentsMatch?.[1] ?? "";
  const argumentRoot = argumentsMatch?.[2] ?? "";
  const hasStartupFlag = argumentsMatch?.[3] !== undefined;
  const launcherDirectory = path.dirname(launcherEntrypoint);
  const expectedLauncherParent = path.join(
    expected.rootDirectory,
    ".lifeline",
    "startup",
    "windows",
  );
  const recognizedVersion = version === 2 || version === 3 || version === 4;
  const recognizedVersionAction =
    (version === 2 && !hasStartupFlag) ||
    ((version === 3 || version === 4) && hasStartupFlag);

  return (
    tagValue(registrationInfo, "Author") === TASK_AUTHOR &&
    tagValue(registrationInfo, "URI") === TASK_URI &&
    recognizedVersion &&
    normalizeComparablePath(describedRoot) ===
      normalizeComparablePath(expected.rootDirectory) &&
    normalizeComparablePath(tagValue(action, "Command")) ===
      normalizeComparablePath(expected.nodeExecutable) &&
    normalizeComparablePath(tagValue(action, "WorkingDirectory")) ===
      normalizeComparablePath(expected.rootDirectory) &&
    normalizeComparablePath(argumentRoot) ===
      normalizeComparablePath(expected.rootDirectory) &&
    normalizeComparablePath(path.dirname(launcherDirectory)) ===
      normalizeComparablePath(expectedLauncherParent) &&
    /^launcher-[0-9a-f]{16}$/i.test(path.basename(launcherDirectory)) &&
    path.basename(launcherEntrypoint).toLowerCase() === "cli.js" &&
    recognizedVersionAction
  );
}

function matchesExpectedTask(
  xml: string,
  expected: ExpectedTaskDefinition,
): boolean {
  const registrationInfo = sectionValue(xml, "RegistrationInfo");
  const settings = sectionValue(xml, "Settings");
  const action = singleExecAction(xml);
  if (
    !action ||
    !expectedLogonTrigger(xml, expected.identity) ||
    !expectedPrincipal(xml, expected.identity)
  ) {
    return false;
  }

  return (
    tagValue(registrationInfo, "Author") === TASK_AUTHOR &&
    tagValue(registrationInfo, "Description") === expected.description &&
    tagValue(registrationInfo, "URI") === TASK_URI &&
    tagHasNoAttributes(xml, "Settings") &&
    matchesRequiredTaskSettings(settings) &&
    normalizeComparablePath(tagValue(action, "Command")) ===
      normalizeComparablePath(expected.nodeExecutable) &&
    tagValue(action, "Arguments") === expected.arguments &&
    normalizeComparablePath(tagValue(action, "WorkingDirectory")) ===
      normalizeComparablePath(expected.workingDirectory)
  );
}

async function inspectTaskDetailed(
  runner: WindowsSchedulerRunner,
  options: WindowsTaskSchedulerOptions,
): Promise<DetailedTaskInspection> {
  const queryResult = await runner([
    "/Query",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
  ]);

  if (queryResult.code === -1) {
    return {
      state: "unsupported",
      detail:
        "Windows Task Scheduler CLI is unavailable, so startup registration cannot be inspected.",
    };
  }

  if (queryResult.code !== 0 && !isTaskMissing(queryResult)) {
    return {
      state: "error",
      detail: `Could not inspect task ${WINDOWS_STARTUP_TASK_NAME}: ${
        queryResult.stderr || queryResult.stdout || "unknown scheduler error"
      }`,
    };
  }

  let expected: ExpectedTaskDefinition;
  try {
    expected = await buildExpectedTaskDefinition(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "error",
      detail: `Could not build the Windows startup definition: ${message}`,
    };
  }

  if (queryResult.code !== 0) {
    return {
      state: "absent",
      expected,
      detail: `Task ${WINDOWS_STARTUP_TASK_NAME} is not currently registered in Windows Task Scheduler.`,
    };
  }

  if (matchesExpectedTask(queryResult.stdout, expected)) {
    return {
      state: "installed",
      expected,
      existingXml: queryResult.stdout,
      detail:
        `Task ${WINDOWS_STARTUP_TASK_NAME} is installed for current user ${expected.identity.account} ` +
        `and runs ${expected.arguments} from ${expected.workingDirectory}.`,
    };
  }

  if (isLifelineOwnedTask(queryResult.stdout, expected)) {
    return {
      state: "owned-drift",
      expected,
      existingXml: queryResult.stdout,
      detail: `Task ${WINDOWS_STARTUP_TASK_NAME} is Lifeline-owned for ${expected.rootDirectory} but its definition drifted from the current launcher contract.`,
    };
  }

  return {
    state: "conflict",
    expected,
    existingXml: queryResult.stdout,
    detail: `Task ${WINDOWS_STARTUP_TASK_NAME} exists with a foreign or conflicting definition; Lifeline will not overwrite or remove it.`,
  };
}

async function ensureLauncherSnapshot(launcher: LauncherPlan): Promise<void> {
  const expectedMetadata = `${JSON.stringify(
    { version: 1, sourceHash: launcher.sourceHash },
    null,
    2,
  )}\n`;
  if (await launcherSnapshotMatches(launcher, expectedMetadata)) {
    return;
  }

  if (
    path.relative(launcher.sourceDirectory, launcher.launcherDirectory) === ""
  ) {
    throw new Error(
      `Stable launcher snapshot verification failed at active source ${launcher.sourceDirectory}; in-place repair is not allowed.`,
    );
  }

  await copyLauncherPayload(
    launcher.sourceDirectory,
    launcher.launcherDirectory,
  );
  const sourceFileSet = new Set(
    await listLauncherPayloadFiles(launcher.sourceDirectory),
  );
  const launcherFiles = await listRelativeFiles(launcher.launcherDirectory);
  for (const relativeFile of launcherFiles) {
    if (relativeFile !== "launcher.json" && !sourceFileSet.has(relativeFile)) {
      await unlink(path.join(launcher.launcherDirectory, relativeFile));
    }
  }
  await writeFile(launcher.launcherMetadataPath, expectedMetadata, "utf8");
  if (!(await launcherSnapshotMatches(launcher, expectedMetadata))) {
    throw new Error(
      `Stable launcher snapshot verification failed at ${launcher.launcherDirectory}.`,
    );
  }
}

function normalizeTaskXmlForComparison(xml: string): string {
  return xml
    .replace(/^\s*<\?xml[^>]*>\s*/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/>\s+</g, "><")
    .trim();
}

async function removeNewlyCreatedTaskAfterFailedReadback(
  runner: WindowsSchedulerRunner,
): Promise<{ verified: boolean; detail: string }> {
  const deleteResult = await runner([
    "/Delete",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/F",
  ]);
  if (deleteResult.code !== 0 && !isTaskMissing(deleteResult)) {
    return {
      verified: false,
      detail: `Rollback also failed: ${
        deleteResult.stderr ||
        deleteResult.stdout ||
        "unknown scheduler delete error"
      }`,
    };
  }

  const readback = await runner([
    "/Query",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
  ]);
  return readback.code !== 0 && isTaskMissing(readback)
    ? {
        verified: true,
        detail:
          "The newly created packet-owned registration was rolled back and absence was verified.",
      }
    : {
        verified: false,
        detail: `Rollback deletion could not be verified: ${
          readback.stderr ||
          readback.stdout ||
          "task still returned a scheduler definition"
        }`,
      };
}

async function restorePriorOwnedTaskAfterFailedReadback(
  runner: WindowsSchedulerRunner,
  launcher: LauncherPlan,
  priorXml: string,
): Promise<{ verified: boolean; detail: string }> {
  const restorableXml = priorXml.replace(/^\s*<\?xml[^>]*>\s*/i, "");
  await writeFile(launcher.rollbackDefinitionPath, restorableXml, "utf8");
  const restoreResult = await runner([
    "/Create",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
    launcher.rollbackDefinitionPath,
    "/F",
  ]);
  if (restoreResult.code !== 0) {
    return {
      verified: false,
      detail: `Prior owned definition restoration failed: ${
        restoreResult.stderr ||
        restoreResult.stdout ||
        "unknown scheduler restore error"
      }`,
    };
  }

  const restoredReadback = await runner([
    "/Query",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
  ]);
  if (
    restoredReadback.code === 0 &&
    normalizeTaskXmlForComparison(restoredReadback.stdout) ===
      normalizeTaskXmlForComparison(priorXml)
  ) {
    return {
      verified: true,
      detail:
        "The exact prior Lifeline-owned definition was restored and verified.",
    };
  }
  return {
    verified: false,
    detail: `Prior owned definition restoration could not be verified: ${
      restoredReadback.stderr ||
      restoredReadback.stdout ||
      "scheduler returned a different definition"
    }`,
  };
}

async function reconcileFailedTaskCreation(
  runner: WindowsSchedulerRunner,
  inspection: DetailedTaskInspection,
): Promise<{
  verified: boolean;
  status: "installed" | "not-installed";
  detail: string;
}> {
  const expected = inspection.expected;
  if (!expected) {
    return {
      verified: false,
      status: "installed",
      detail:
        "FAIL-CLOSED BLOCKER: expected task identity was unavailable during create reconciliation.",
    };
  }
  const readback = await runner([
    "/Query",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
  ]);

  if (inspection.state === "owned-drift" && inspection.existingXml) {
    if (
      readback.code === 0 &&
      normalizeTaskXmlForComparison(readback.stdout) ===
        normalizeTaskXmlForComparison(inspection.existingXml)
    ) {
      return {
        verified: true,
        status: "installed",
        detail:
          "The current-v4 enable failed; the exact prior Lifeline-owned definition remains installed, unchanged, and verified.",
      };
    }
    const restoration = await restorePriorOwnedTaskAfterFailedReadback(
      runner,
      expected.launcher,
      inspection.existingXml,
    );
    return {
      verified: restoration.verified,
      status: "installed",
      detail: restoration.verified
        ? `The current-v4 enable failed; ${restoration.detail}`
        : restoration.detail,
    };
  }

  if (readback.code !== 0 && isTaskMissing(readback)) {
    return {
      verified: true,
      status: "not-installed",
      detail: "The task remained absent and absence was verified.",
    };
  }
  if (
    readback.code === 0 &&
    (matchesExpectedTask(readback.stdout, expected) ||
      isLifelineOwnedTask(readback.stdout, expected))
  ) {
    const removal = await removeNewlyCreatedTaskAfterFailedReadback(runner);
    return {
      verified: removal.verified,
      status: removal.verified ? "not-installed" : "installed",
      detail: removal.detail,
    };
  }

  return {
    verified: false,
    status: "installed",
    detail: `FAIL-CLOSED BLOCKER: create transaction left task ownership or absence ambiguous: ${
      readback.stderr ||
      readback.stdout ||
      "scheduler query did not prove absence"
    }`,
  };
}

function toBackendInspection(
  detailed: DetailedTaskInspection,
): StartupBackendInspection {
  return {
    supported: detailed.state !== "unsupported",
    status:
      detailed.state === "installed"
        ? "installed"
        : detailed.state === "unsupported"
          ? "unsupported"
          : "not-installed",
    mechanism: TASK_MECHANISM,
    detail: detailed.detail,
  };
}

export function createWindowsTaskSchedulerBackend(
  runner: WindowsSchedulerRunner = runSchtasks,
  options: WindowsTaskSchedulerOptions = {},
): StartupBackend {
  return {
    id: TASK_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: async () =>
      toBackendInspection(await inspectTaskDetailed(runner, options)),
    install: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      const inspection = await inspectTaskDetailed(runner, options);
      if (request.dryRun) {
        return {
          status: toBackendInspection(inspection).status,
          detail:
            inspection.state === "installed"
              ? `Dry-run: task ${WINDOWS_STARTUP_TASK_NAME} already has the exact current-user definition; no mutation required.`
              : inspection.state === "absent" && inspection.expected
                ? `Dry-run: would snapshot the Lifeline launcher beneath ${inspection.expected.rootDirectory} and register task ${WINDOWS_STARTUP_TASK_NAME} for current-user logon.`
                : inspection.state === "owned-drift" && inspection.expected
                  ? `Dry-run: would reconcile Lifeline-owned task ${WINDOWS_STARTUP_TASK_NAME} for ${inspection.expected.rootDirectory} to the exact current-v4 definition while preserving the same task identity.`
                  : `Dry-run blocked. ${inspection.detail}`,
          ...(inspection.state === "conflict" || inspection.state === "error"
            ? { ok: false }
            : {}),
        };
      }

      if (inspection.state === "unsupported") {
        return { status: "unsupported", detail: inspection.detail, ok: false };
      }
      if (inspection.state === "conflict" || inspection.state === "error") {
        return {
          status: "not-installed",
          detail: inspection.detail,
          ok: false,
        };
      }
      const expected = inspection.expected;
      if (!expected) {
        return {
          status: "not-installed",
          detail:
            "Could not build the expected Windows startup task definition.",
          ok: false,
        };
      }

      await ensureLauncherSnapshot(expected.launcher);
      if (inspection.state === "installed") {
        return {
          status: "installed",
          detail: `Task ${WINDOWS_STARTUP_TASK_NAME} already has the exact current-user definition; no scheduler mutation was required.`,
        };
      }

      await mkdir(path.dirname(expected.launcher.taskDefinitionPath), {
        recursive: true,
      });
      await writeFile(
        expected.launcher.taskDefinitionPath,
        expected.xml,
        "utf8",
      );

      const createArgs = [
        "/Create",
        "/TN",
        WINDOWS_STARTUP_TASK_NAME,
        "/XML",
        expected.launcher.taskDefinitionPath,
        ...(inspection.state === "owned-drift" ? ["/F"] : []),
      ];
      const createResult = await runner(createArgs);
      if (createResult.code !== 0) {
        const reconciliation = await reconcileFailedTaskCreation(
          runner,
          inspection,
        );
        return {
          status: reconciliation.status,
          ok: false,
          detail: `Failed to register task ${WINDOWS_STARTUP_TASK_NAME}: ${
            createResult.stderr ||
            createResult.stdout ||
            "unknown scheduler error"
          }. ${reconciliation.detail}${
            reconciliation.verified
              ? ""
              : " Startup transaction integrity could not be verified."
          }`,
        };
      }

      const readback = await inspectTaskDetailed(runner, options);
      if (readback.state !== "installed" || !readback.expected) {
        const rollback = await reconcileFailedTaskCreation(runner, inspection);
        return {
          status: rollback.status,
          ok: false,
          detail: `Task ${WINDOWS_STARTUP_TASK_NAME} registration did not pass exact readback: ${readback.detail} ${rollback.detail}${
            rollback.verified
              ? ""
              : " FAIL-CLOSED BLOCKER: startup transaction integrity could not be verified."
          }`,
        };
      }

      return {
        status: "installed",
        detail:
          `Registered task ${WINDOWS_STARTUP_TASK_NAME} for current user ${readback.expected.identity.account}; ` +
          `stable launcher: ${readback.expected.launcher.launcherEntrypoint}; root: ${readback.expected.rootDirectory}.`,
      };
    },
    uninstall: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      const inspection = await inspectTaskDetailed(runner, options);
      if (request.dryRun) {
        return {
          status: toBackendInspection(inspection).status,
          detail:
            inspection.state === "installed" ||
            inspection.state === "owned-drift"
              ? `Dry-run: would remove Lifeline-owned task ${WINDOWS_STARTUP_TASK_NAME}.`
              : inspection.state === "absent"
                ? `Dry-run: task ${WINDOWS_STARTUP_TASK_NAME} is not present; no mutation required.`
                : `Dry-run blocked. ${inspection.detail}`,
          ...(inspection.state === "conflict" || inspection.state === "error"
            ? { ok: false }
            : {}),
        };
      }

      if (inspection.state === "unsupported") {
        return { status: "unsupported", detail: inspection.detail, ok: false };
      }
      if (inspection.state === "conflict" || inspection.state === "error") {
        return {
          status: "not-installed",
          detail: inspection.detail,
          ok: false,
        };
      }
      if (inspection.state === "absent") {
        return {
          status: "not-installed",
          detail: `Task ${WINDOWS_STARTUP_TASK_NAME} is already absent from Windows Task Scheduler.`,
        };
      }

      const deleteResult = await runner([
        "/Delete",
        "/TN",
        WINDOWS_STARTUP_TASK_NAME,
        "/F",
      ]);
      const deleteFailure =
        deleteResult.code !== 0 && !isTaskMissing(deleteResult)
          ? deleteResult.stderr ||
            deleteResult.stdout ||
            "unknown scheduler delete error"
          : undefined;

      const removalReadback = await runner([
        "/Query",
        "/TN",
        WINDOWS_STARTUP_TASK_NAME,
        "/XML",
      ]);
      if (removalReadback.code === 0) {
        return {
          status: "installed",
          ok: false,
          detail: `Failed to verify removal of task ${WINDOWS_STARTUP_TASK_NAME}: the exact task identity is still present${deleteFailure ? ` after delete error: ${deleteFailure}` : ""}. Startup intent remains enabled.`,
        };
      }
      if (!isTaskMissing(removalReadback)) {
        return {
          status: "installed",
          ok: false,
          detail: `FAIL-CLOSED BLOCKER: removal of task ${WINDOWS_STARTUP_TASK_NAME} could not be verified: ${
            removalReadback.stderr ||
            removalReadback.stdout ||
            "scheduler query did not prove absence"
          }. Startup intent remains enabled.`,
        };
      }

      return {
        status: "not-installed",
        detail: deleteFailure
          ? `Task ${WINDOWS_STARTUP_TASK_NAME} is absent after a scheduler delete error and absence was verified: ${deleteFailure}.`
          : `Removed Lifeline-owned task ${WINDOWS_STARTUP_TASK_NAME} from Windows Task Scheduler and verified its absence.`,
      };
    },
  };
}
