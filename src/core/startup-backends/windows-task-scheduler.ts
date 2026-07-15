import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
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
const TASK_DEFINITION_VERSION = 3;

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
  expected: ExpectedTaskDefinition;
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
        stderr: normalizeOutput(`Unable to execute ${command}: ${error.message}`),
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
  const identity = result.code === 0 ? parseWhoamiCsv(result.stdout) : undefined;
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

function isTrueOrDefault(value: string): boolean {
  return value === "" || value.toLowerCase() === "true";
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
    } else if (typeof entry === "string" || entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFilesRecursively(directory);
  for (const file of files) {
    const relativePath = path.relative(directory, file).replaceAll("\\", "/");
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(file, "utf8"), "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    if (typeof entry !== "string" && entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (typeof entry === "string" || entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function buildLauncherPlan(
  rootDirectory: string,
  cliEntrypoint: string,
): Promise<LauncherPlan> {
  const sourceDirectory = path.dirname(cliEntrypoint);
  const sourceHash = await hashDirectory(sourceDirectory);
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
  return {
    sourceDirectory,
    sourceHash,
    launcherDirectory,
    launcherEntrypoint: path.join(launcherDirectory, "cli.js"),
    launcherMetadataPath: path.join(launcherDirectory, "launcher.json"),
    taskDefinitionPath: path.join(startupDirectory, "task-definition.xml"),
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
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
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
  const rootDirectory = path.resolve(options.rootDirectory ?? getLifelineRoot());
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const cliEntrypoint = path.resolve(
    options.cliEntrypoint ??
      fileURLToPath(new URL("../../cli.js", import.meta.url)),
  );
  const identity = options.identity ?? (await resolveCurrentIdentity());
  const launcher = await buildLauncherPlan(rootDirectory, cliEntrypoint);

  if (rootDirectory.includes('"') || launcher.launcherEntrypoint.includes('"')) {
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
  const logonTrigger = sectionValue(xml, "LogonTrigger");
  const principal = sectionValue(xml, "Principal");
  const action = sectionValue(xml, "Exec");
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
  const recognizedVersion = version === 2 || version === 3;
  const recognizedVersionAction =
    (version === 2 && !hasStartupFlag) || (version === 3 && hasStartupFlag);

  return (
    tagValue(registrationInfo, "Author") === TASK_AUTHOR &&
    tagValue(registrationInfo, "URI") === TASK_URI &&
    matchesExpectedIdentity(tagValue(logonTrigger, "UserId"), expected.identity) &&
    matchesExpectedIdentity(tagValue(principal, "UserId"), expected.identity) &&
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
  const logonTrigger = sectionValue(xml, "LogonTrigger");
  const principal = sectionValue(xml, "Principal");
  const settings = sectionValue(xml, "Settings");
  const action = sectionValue(xml, "Exec");
  const runLevel = tagValue(principal, "RunLevel");

  return (
    tagValue(registrationInfo, "Author") === TASK_AUTHOR &&
    tagValue(registrationInfo, "Description") === expected.description &&
    tagValue(registrationInfo, "URI") === TASK_URI &&
    matchesExpectedIdentity(tagValue(logonTrigger, "UserId"), expected.identity) &&
    isTrueOrDefault(tagValue(logonTrigger, "Enabled")) &&
    matchesExpectedIdentity(tagValue(principal, "UserId"), expected.identity) &&
    tagValue(principal, "LogonType") === "InteractiveToken" &&
    (runLevel === "" || runLevel === "LeastPrivilege") &&
    tagValue(settings, "MultipleInstancesPolicy") === "IgnoreNew" &&
    isTrueOrDefault(tagValue(settings, "Enabled")) &&
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
  const expected = await buildExpectedTaskDefinition(options);
  const queryResult = await runner([
    "/Query",
    "/TN",
    WINDOWS_STARTUP_TASK_NAME,
    "/XML",
    "ONE",
  ]);

  if (queryResult.code === -1) {
    return {
      state: "unsupported",
      expected,
      detail:
        "Windows Task Scheduler CLI is unavailable, so startup registration cannot be inspected.",
    };
  }

  if (queryResult.code !== 0) {
    return isTaskMissing(queryResult)
      ? {
          state: "absent",
          expected,
          detail: `Task ${WINDOWS_STARTUP_TASK_NAME} is not currently registered in Windows Task Scheduler.`,
        }
      : {
          state: "error",
          expected,
          detail: `Could not inspect task ${WINDOWS_STARTUP_TASK_NAME}: ${
            queryResult.stderr || queryResult.stdout || "unknown scheduler error"
          }`,
        };
  }

  if (matchesExpectedTask(queryResult.stdout, expected)) {
    return {
      state: "installed",
      expected,
      detail:
        `Task ${WINDOWS_STARTUP_TASK_NAME} is installed for current user ${expected.identity.account} ` +
        `and runs ${expected.arguments} from ${expected.workingDirectory}.`,
    };
  }

  if (isLifelineOwnedTask(queryResult.stdout, expected)) {
    return {
      state: "owned-drift",
      expected,
      detail: `Task ${WINDOWS_STARTUP_TASK_NAME} is Lifeline-owned for ${expected.rootDirectory} but its definition drifted from the current launcher contract.`,
    };
  }

  return {
    state: "conflict",
    expected,
    detail: `Task ${WINDOWS_STARTUP_TASK_NAME} exists with a foreign or conflicting definition; Lifeline will not overwrite or remove it.`,
  };
}

async function ensureLauncherSnapshot(launcher: LauncherPlan): Promise<void> {
  const expectedMetadata = `${JSON.stringify(
    { version: 1, sourceHash: launcher.sourceHash },
    null,
    2,
  )}\n`;
  const existingMetadata = await readFile(
    launcher.launcherMetadataPath,
    "utf8",
  ).catch(() => "");
  const launcherExists = await access(launcher.launcherEntrypoint)
    .then(() => true)
    .catch(() => false);
  if (launcherExists && existingMetadata === expectedMetadata) {
    return;
  }

  await copyDirectory(launcher.sourceDirectory, launcher.launcherDirectory);
  await writeFile(
    launcher.launcherMetadataPath,
    expectedMetadata,
    "utf8",
  );
}

function toBackendInspection(
  detailed: DetailedTaskInspection,
): StartupBackendInspection {
  return {
    supported: detailed.state !== "unsupported",
    status: detailed.state === "installed" ? "installed" :
      detailed.state === "unsupported" ? "unsupported" : "not-installed",
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
              : inspection.state === "absent"
                ? `Dry-run: would snapshot the Lifeline launcher beneath ${inspection.expected.rootDirectory} and register task ${WINDOWS_STARTUP_TASK_NAME} for current-user logon.`
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
        return { status: "not-installed", detail: inspection.detail, ok: false };
      }

      await ensureLauncherSnapshot(inspection.expected.launcher);
      if (inspection.state === "installed") {
        return {
          status: "installed",
          detail: `Task ${WINDOWS_STARTUP_TASK_NAME} already has the exact current-user definition; no scheduler mutation was required.`,
        };
      }

      await mkdir(path.dirname(inspection.expected.launcher.taskDefinitionPath), {
        recursive: true,
      });
      await writeFile(
        inspection.expected.launcher.taskDefinitionPath,
        inspection.expected.xml,
        "utf8",
      );

      const createArgs = [
        "/Create",
        "/TN",
        WINDOWS_STARTUP_TASK_NAME,
        "/XML",
        inspection.expected.launcher.taskDefinitionPath,
        ...(inspection.state === "owned-drift" ? ["/F"] : []),
      ];
      const createResult = await runner(createArgs);
      if (createResult.code !== 0) {
        return {
          status: "not-installed",
          ok: false,
          detail: `Failed to register task ${WINDOWS_STARTUP_TASK_NAME}: ${
            createResult.stderr || createResult.stdout || "unknown scheduler error"
          }`,
        };
      }

      const readback = await inspectTaskDetailed(runner, options);
      if (readback.state !== "installed") {
        const rollbackResult = await runner([
          "/Delete",
          "/TN",
          WINDOWS_STARTUP_TASK_NAME,
          "/F",
        ]);
        const rollbackDetail =
          rollbackResult.code === 0 || isTaskMissing(rollbackResult)
            ? "The packet-owned registration was rolled back."
            : `Rollback also failed: ${
                rollbackResult.stderr ||
                rollbackResult.stdout ||
                "unknown scheduler error"
              }`;
        return {
          status: "not-installed",
          ok: false,
          detail:
            `Task ${WINDOWS_STARTUP_TASK_NAME} registration did not pass exact readback: ` +
            `${readback.detail} ${rollbackDetail}`,
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
            inspection.state === "installed" || inspection.state === "owned-drift"
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
        return { status: "not-installed", detail: inspection.detail, ok: false };
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
      if (deleteResult.code !== 0 && !isTaskMissing(deleteResult)) {
        return {
          status: "installed",
          ok: false,
          detail: `Failed to remove task ${WINDOWS_STARTUP_TASK_NAME}: ${
            deleteResult.stderr || deleteResult.stdout || "unknown scheduler error"
          }`,
        };
      }

      return {
        status: "not-installed",
        detail: `Removed Lifeline-owned task ${WINDOWS_STARTUP_TASK_NAME} from Windows Task Scheduler.`,
      };
    },
  };
}
