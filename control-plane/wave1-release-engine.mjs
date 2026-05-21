import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildWave1ReleasePlan,
  parseWave1ReleaseMetadata,
  serializeWave1ReleaseMetadata,
} from "./wave1-deploy-contract.mjs";

export const WAVE1_RELEASE_POINTER_VERSION =
  "atlas.lifeline.release-pointer.v1";
export const WAVE1_RELEASE_RECEIPT_VERSION =
  "atlas.lifeline.release-receipt.v1";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pushIssue(issues, path, message) {
  issues.push({ path, message });
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = stableJsonValue(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(stableJsonValue(value), null, 2);
}

const SUPPORTED_RELEASE_RECEIPT_ACTIONS = ["planned", "activate", "rollback"];
const SUPPORTED_RELEASE_RECEIPT_STATUSES = ["planned", "succeeded", "failed"];
const SUPPORTED_RELEASE_PHASE_STATUSES = ["succeeded", "failed"];
const SUPPORTED_RELEASE_RECEIPT_FAILURE_PHASES = [
  "preActivate",
  "healthcheck",
  "postActivate",
  "preRollback",
];
const SUPPORTED_ROLLBACK_STRATEGIES = ["redeploy", "restore"];
const SUPPORTED_SOURCE_ADAPTER_KINDS = ["artifactRef", "imageRef", "branch"];

function validateReleaseTarget(receipt, issues) {
  if (!isRecord(receipt.releaseTarget)) {
    pushIssue(issues, "releaseTarget", "must be an object");
    return;
  }

  if (receipt.releaseTarget.kind !== "single-host-immutable") {
    pushIssue(issues, "releaseTarget.kind", "must equal single-host-immutable");
  }

  if (!isNonEmptyString(receipt.releaseTarget.releaseId)) {
    pushIssue(issues, "releaseTarget.releaseId", "must be a non-empty string");
  }

  if (!isNonEmptyString(receipt.releaseTarget.artifactRef)) {
    pushIssue(issues, "releaseTarget.artifactRef", "must be a non-empty string");
  }
}

function validateRollbackTarget(receipt, issues) {
  if (!isRecord(receipt.rollbackTarget)) {
    pushIssue(issues, "rollbackTarget", "must be an object");
    return;
  }

  if (!isNonEmptyString(receipt.rollbackTarget.releaseId)) {
    pushIssue(issues, "rollbackTarget.releaseId", "must be a non-empty string");
  }

  if (!isNonEmptyString(receipt.rollbackTarget.artifactRef)) {
    pushIssue(issues, "rollbackTarget.artifactRef", "must be a non-empty string");
  }

  if (
    !isNonEmptyString(receipt.rollbackTarget.strategy) ||
    !SUPPORTED_ROLLBACK_STRATEGIES.includes(receipt.rollbackTarget.strategy)
  ) {
    pushIssue(
      issues,
      "rollbackTarget.strategy",
      `must be one of: ${SUPPORTED_ROLLBACK_STRATEGIES.join(", ")}`,
    );
  }

  if (
    receipt.rollbackTarget.note !== undefined &&
    !isNonEmptyString(receipt.rollbackTarget.note)
  ) {
    pushIssue(issues, "rollbackTarget.note", "must be a non-empty string");
  }
}

function validateSourceAdapter(receipt, issues) {
  if (receipt.sourceAdapter === undefined) {
    return;
  }

  if (!isRecord(receipt.sourceAdapter)) {
    pushIssue(issues, "sourceAdapter", "must be an object");
    return;
  }

  if (
    !isNonEmptyString(receipt.sourceAdapter.kind) ||
    !SUPPORTED_SOURCE_ADAPTER_KINDS.includes(receipt.sourceAdapter.kind)
  ) {
    pushIssue(
      issues,
      "sourceAdapter.kind",
      `must be one of: ${SUPPORTED_SOURCE_ADAPTER_KINDS.join(", ")}`,
    );
  }

  if (!isNonEmptyString(receipt.sourceAdapter.canonicalArtifactRef)) {
    pushIssue(
      issues,
      "sourceAdapter.canonicalArtifactRef",
      "must be a non-empty string",
    );
  }

  if (
    receipt.sourceAdapter.kind === "artifactRef" &&
    !isNonEmptyString(receipt.sourceAdapter.artifactRef)
  ) {
    pushIssue(
      issues,
      "sourceAdapter.artifactRef",
      "must be a non-empty string",
    );
  }

  if (
    receipt.sourceAdapter.kind === "imageRef" &&
    !isNonEmptyString(receipt.sourceAdapter.imageRef)
  ) {
    pushIssue(issues, "sourceAdapter.imageRef", "must be a non-empty string");
  }

  if (receipt.sourceAdapter.kind === "branch") {
    if (!isNonEmptyString(receipt.sourceAdapter.repo)) {
      pushIssue(issues, "sourceAdapter.repo", "must be a non-empty string");
    }

    if (!isNonEmptyString(receipt.sourceAdapter.branch)) {
      pushIssue(issues, "sourceAdapter.branch", "must be a non-empty string");
    }
  }
}

function validateHealth(receipt, issues) {
  if (receipt.health === undefined) {
    return;
  }

  if (!isRecord(receipt.health)) {
    pushIssue(issues, "health", "must be an object");
    return;
  }

  if (typeof receipt.health.ok !== "boolean") {
    pushIssue(issues, "health.ok", "must be a boolean");
  }

  if (
    receipt.health.status !== undefined &&
    !Number.isInteger(receipt.health.status)
  ) {
    pushIssue(issues, "health.status", "must be an integer");
  }

  if (
    receipt.health.error !== undefined &&
    !isNonEmptyString(receipt.health.error)
  ) {
    pushIssue(issues, "health.error", "must be a non-empty string");
  }
}

function validatePhaseCommands(commands, phasePath, issues) {
  if (!Array.isArray(commands)) {
    pushIssue(issues, `${phasePath}.commands`, "must be an array");
    return;
  }

  commands.forEach((commandResult, index) => {
    const commandPath = `${phasePath}.commands.${index}`;
    if (!isRecord(commandResult)) {
      pushIssue(issues, commandPath, "must be an object");
      return;
    }

    if (!isNonEmptyString(commandResult.command)) {
      pushIssue(issues, `${commandPath}.command`, "must be a non-empty string");
    }

    if (
      !isNonEmptyString(commandResult.status) ||
      !SUPPORTED_RELEASE_PHASE_STATUSES.includes(commandResult.status)
    ) {
      pushIssue(
        issues,
        `${commandPath}.status`,
        `must be one of: ${SUPPORTED_RELEASE_PHASE_STATUSES.join(", ")}`,
      );
    }

    if (!Number.isInteger(commandResult.exitCode)) {
      pushIssue(issues, `${commandPath}.exitCode`, "must be an integer");
    }

    if (
      commandResult.signal !== undefined &&
      !isNonEmptyString(commandResult.signal)
    ) {
      pushIssue(issues, `${commandPath}.signal`, "must be a non-empty string");
    }
  });
}

function validatePhaseResult(phaseEvidence, phaseName, issues) {
  const phase = phaseEvidence?.[phaseName];
  if (!isRecord(phase)) {
    pushIssue(issues, `phaseEvidence.${phaseName}`, "must be an object");
    return;
  }

  if (phase.phase !== phaseName) {
    pushIssue(issues, `phaseEvidence.${phaseName}.phase`, `must equal ${phaseName}`);
  }

  if (
    !isNonEmptyString(phase.status) ||
    !SUPPORTED_RELEASE_PHASE_STATUSES.includes(phase.status)
  ) {
    pushIssue(
      issues,
      `phaseEvidence.${phaseName}.status`,
      `must be one of: ${SUPPORTED_RELEASE_PHASE_STATUSES.join(", ")}`,
    );
  }

  validatePhaseCommands(phase.commands, `phaseEvidence.${phaseName}`, issues);
}

function validateLineage(receipt, issues) {
  if (receipt.lineage === undefined) {
    return;
  }

  if (!isRecord(receipt.lineage)) {
    pushIssue(issues, "lineage", "must be an object");
    return;
  }

  if (
    receipt.lineage.promotedFromReleaseId !== undefined &&
    !isNonEmptyString(receipt.lineage.promotedFromReleaseId)
  ) {
    pushIssue(issues, "lineage.promotedFromReleaseId", "must be a non-empty string");
  }

  if (!isNonEmptyString(receipt.lineage.promotedToReleaseId)) {
    pushIssue(issues, "lineage.promotedToReleaseId", "must be a non-empty string");
  }
}

function validateOptionalStringField(receipt, fieldName, issues) {
  if (receipt[fieldName] !== undefined && !isNonEmptyString(receipt[fieldName])) {
    pushIssue(issues, fieldName, "must be a non-empty string");
  }
}

function validatePhaseEvidence(receipt, issues) {
  if (receipt.phaseEvidence === undefined) {
    return;
  }

  if (!isRecord(receipt.phaseEvidence)) {
    pushIssue(issues, "phaseEvidence", "must be an object");
    return;
  }

  if (receipt.action === "activate") {
    validatePhaseResult(receipt.phaseEvidence, "preActivate", issues);

    if (
      receipt.status === "succeeded" ||
      receipt.failedPhase === "postActivate"
    ) {
      validatePhaseResult(receipt.phaseEvidence, "postActivate", issues);
    }
  }

  if (receipt.action === "rollback") {
    validatePhaseResult(receipt.phaseEvidence, "preRollback", issues);
  }
}

export function validateWave1ReleaseReceipt(value) {
  const issues = [];

  if (!isRecord(value)) {
    return {
      issues: [{ path: "$", message: "release receipt must be a JSON object" }],
    };
  }

  if (value.contractVersion !== WAVE1_RELEASE_RECEIPT_VERSION) {
    pushIssue(
      issues,
      "contractVersion",
      `must equal ${WAVE1_RELEASE_RECEIPT_VERSION}`,
    );
  }

  if (!isNonEmptyString(value.receiptId)) {
    pushIssue(issues, "receiptId", "must be a non-empty string");
  }

  if (
    !isNonEmptyString(value.action) ||
    !SUPPORTED_RELEASE_RECEIPT_ACTIONS.includes(value.action)
  ) {
    pushIssue(
      issues,
      "action",
      `must be one of: ${SUPPORTED_RELEASE_RECEIPT_ACTIONS.join(", ")}`,
    );
  }

  if (
    !isNonEmptyString(value.status) ||
    !SUPPORTED_RELEASE_RECEIPT_STATUSES.includes(value.status)
  ) {
    pushIssue(
      issues,
      "status",
      `must be one of: ${SUPPORTED_RELEASE_RECEIPT_STATUSES.join(", ")}`,
    );
  }

  [
    "appName",
    "releaseId",
    "createdAt",
    "releaseDirectory",
    "releaseMetadataPath",
    "currentPointerPath",
    "previousPointerPath",
  ].forEach((fieldName) => {
    if (!isNonEmptyString(value[fieldName])) {
      pushIssue(issues, fieldName, "must be a non-empty string");
    }
  });

  validateReleaseTarget(value, issues);
  validateRollbackTarget(value, issues);
  validateSourceAdapter(value, issues);
  validateHealth(value, issues);
  validatePhaseEvidence(value, issues);
  validateLineage(value, issues);

  [
    "previousReleaseId",
    "failedPhase",
    "preservedCurrentReleaseId",
    "preservedPreviousReleaseId",
  ].forEach((fieldName) => validateOptionalStringField(value, fieldName, issues));

  if (
    value.revertedPointers !== undefined &&
    typeof value.revertedPointers !== "boolean"
  ) {
    pushIssue(issues, "revertedPointers", "must be a boolean");
  }

  if (value.action === "planned" && value.status !== "planned") {
    pushIssue(issues, "status", "planned receipts must use planned status");
  }

  if (
    (value.action === "activate" || value.action === "rollback") &&
    value.status === "planned"
  ) {
    pushIssue(issues, "status", `${value.action} receipts must not use planned status`);
  }

  if (value.action === "activate" && value.status === "succeeded") {
    if (value.health === undefined) {
      pushIssue(issues, "health", "is required for successful activate receipts");
    }

    if (value.phaseEvidence === undefined) {
      pushIssue(
        issues,
        "phaseEvidence",
        "is required for successful activate receipts",
      );
    }

    if (value.lineage === undefined) {
      pushIssue(issues, "lineage", "is required for successful activate receipts");
    }
  }

  if (value.action === "activate" && value.status === "failed") {
    if (!isNonEmptyString(value.failedPhase)) {
      pushIssue(issues, "failedPhase", "is required for failed activate receipts");
    } else if (
      !["preActivate", "healthcheck", "postActivate"].includes(value.failedPhase)
    ) {
      pushIssue(
        issues,
        "failedPhase",
        "must be one of: preActivate, healthcheck, postActivate",
      );
    }

    if (value.phaseEvidence === undefined) {
      pushIssue(issues, "phaseEvidence", "is required for failed activate receipts");
    }

    if (value.failedPhase === "healthcheck" && value.health === undefined) {
      pushIssue(
        issues,
        "health",
        "is required when activate failedPhase is healthcheck",
      );
    }
  }

  if (value.action === "rollback") {
    if (!isNonEmptyString(value.previousReleaseId)) {
      pushIssue(
        issues,
        "previousReleaseId",
        "is required for rollback receipts",
      );
    }
  }

  if (value.action === "rollback" && value.status === "succeeded") {
    if (value.health === undefined) {
      pushIssue(issues, "health", "is required for successful rollback receipts");
    }

    if (value.phaseEvidence === undefined) {
      pushIssue(
        issues,
        "phaseEvidence",
        "is required for successful rollback receipts",
      );
    }

    if (value.lineage === undefined) {
      pushIssue(issues, "lineage", "is required for successful rollback receipts");
    } else if (!isNonEmptyString(value.lineage.promotedFromReleaseId)) {
      pushIssue(
        issues,
        "lineage.promotedFromReleaseId",
        "is required for successful rollback receipts",
      );
    }
  }

  if (value.action === "rollback" && value.status === "failed") {
    if (!isNonEmptyString(value.failedPhase)) {
      pushIssue(issues, "failedPhase", "is required for failed rollback receipts");
    } else if (!["preRollback", "healthcheck"].includes(value.failedPhase)) {
      pushIssue(
        issues,
        "failedPhase",
        "must be one of: preRollback, healthcheck",
      );
    }

    if (value.phaseEvidence === undefined) {
      pushIssue(issues, "phaseEvidence", "is required for failed rollback receipts");
    }

    if (value.failedPhase === "healthcheck" && value.health === undefined) {
      pushIssue(
        issues,
        "health",
        "is required when rollback failedPhase is healthcheck",
      );
    }
  }

  if (
    isNonEmptyString(value.failedPhase) &&
    !SUPPORTED_RELEASE_RECEIPT_FAILURE_PHASES.includes(value.failedPhase)
  ) {
    pushIssue(
      issues,
      "failedPhase",
      `must be one of: ${SUPPORTED_RELEASE_RECEIPT_FAILURE_PHASES.join(", ")}`,
    );
  }

  return issues.length > 0 ? { issues } : { issues: [], receipt: value };
}

export function parseWave1ReleaseReceipt(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      issues: [
        {
          path: "$",
          message:
            error instanceof Error ? error.message : "could not parse JSON",
        },
      ],
    };
  }

  return validateWave1ReleaseReceipt(parsed);
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function normalizeRelativePath(rootDir, filePath) {
  return normalizePath(path.relative(rootDir, filePath));
}

function releaseRoot(rootDir) {
  return path.join(rootDir, ".lifeline", "releases");
}

function validateReleaseAppName(appName) {
  if (typeof appName !== "string" || appName.trim().length === 0) {
    throw new Error("App name must be a non-empty string.");
  }

  if (path.isAbsolute(appName)) {
    throw new Error(`Invalid appName "${appName}": absolute paths are not allowed.`);
  }

  if (appName.includes("/") || appName.includes("\\")) {
    throw new Error(
      `Invalid appName "${appName}": path separators are not allowed.`,
    );
  }

  if (appName === "." || appName === "..") {
    throw new Error(
      `Invalid appName "${appName}": dot-segment values are not allowed.`,
    );
  }

  return appName;
}

function appReleaseRoot(rootDir, appName) {
  return path.join(releaseRoot(rootDir), validateReleaseAppName(appName));
}

function hasPathEscape(relativePath) {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function assertPathWithinRoot(rootPath, candidatePath, label) {
  const relativePath = path.relative(rootPath, candidatePath);
  if (relativePath === "" || !hasPathEscape(relativePath)) {
    return candidatePath;
  }

  throw new Error(`${label} must stay within ${rootPath}`);
}

function validateReleaseId(releaseId) {
  if (typeof releaseId !== "string" || releaseId.trim().length === 0) {
    throw new Error("Release id must be a non-empty string.");
  }

  if (path.isAbsolute(releaseId)) {
    throw new Error(`Invalid releaseId "${releaseId}": absolute paths are not allowed.`);
  }

  if (releaseId.includes("/") || releaseId.includes("\\")) {
    throw new Error(
      `Invalid releaseId "${releaseId}": path separators are not allowed.`,
    );
  }

  if (releaseId === "." || releaseId === "..") {
    throw new Error(
      `Invalid releaseId "${releaseId}": dot-segment values are not allowed.`,
    );
  }

  return releaseId;
}

function resolveReleaseScopedPath(rootDir, appName, releaseId, ...segments) {
  const appRoot = path.resolve(appReleaseRoot(rootDir, appName));
  const validatedReleaseId = validateReleaseId(releaseId);
  const releaseDir = assertPathWithinRoot(
    appRoot,
    path.resolve(appRoot, validatedReleaseId),
    `Release directory for ${appName}/${releaseId}`,
  );

  if (segments.length === 0) {
    return releaseDir;
  }

  return assertPathWithinRoot(
    appRoot,
    path.resolve(releaseDir, ...segments),
    `Release path for ${appName}/${releaseId}`,
  );
}

function releaseDirectory(rootDir, appName, releaseId) {
  return resolveReleaseScopedPath(rootDir, appName, releaseId);
}

function releaseMetadataPath(rootDir, appName, releaseId) {
  return resolveReleaseScopedPath(rootDir, appName, releaseId, "metadata.json");
}

function currentPointerPath(rootDir, appName) {
  return path.join(appReleaseRoot(rootDir, appName), "current.json");
}

function previousPointerPath(rootDir, appName) {
  return path.join(appReleaseRoot(rootDir, appName), "previous.json");
}

function receiptsDirectory(rootDir, appName) {
  return path.join(appReleaseRoot(rootDir, appName), "receipts");
}

function getMigrationHookCommands(migrationHooks, hookName) {
  const hookCommands = migrationHooks?.[hookName];
  return Array.isArray(hookCommands) ? hookCommands : [];
}

function executeShellCommand(command, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolve({
        command,
        status: "failed",
        exitCode: 1,
        signal: undefined,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    child.on("close", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve({
          command,
          status: "succeeded",
          exitCode: 0,
          signal: undefined,
          stdout,
          stderr,
        });
        return;
      }

      resolve({
        command,
        status: "failed",
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        signal: signal ?? undefined,
        stdout,
        stderr,
        ...(signal ? { error: `Command terminated by signal ${signal}` } : {}),
      });
    });
  });
}

async function runReleasePhase(rootDir, phase, hookCommands) {
  const commands = Array.isArray(hookCommands) ? hookCommands : [];
  const commandResults = [];

  for (const command of commands) {
    const result = await executeShellCommand(command, { cwd: rootDir });
    commandResults.push({
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
    });

    if (result.status !== "succeeded") {
      return {
        phase,
        status: "failed",
        commands: commandResults,
      };
    }
  }

  return {
    phase,
    status: "succeeded",
    commands: commandResults,
  };
}

async function restoreReleasePointers(rootDir, appName, current, previous) {
  const currentPath = currentPointerPath(rootDir, appName);
  const previousPath = previousPointerPath(rootDir, appName);

  if (current) {
    await writePointer(currentPath, current);
  } else {
    await clearPointer(currentPath);
  }

  if (previous) {
    await writePointer(previousPath, previous);
  } else {
    await clearPointer(previousPath);
  }
}

function deriveReceiptId(payload) {
  return createHash("sha256")
    .update(stableJsonStringify(payload))
    .digest("hex")
    .slice(0, 16);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeStableJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${stableJsonStringify(payload)}\n`, "utf8");
}

async function writeImmutableJson(filePath, payload) {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    const next = `${stableJsonStringify(payload)}\n`;
    if (existing !== next) {
      throw new Error(`Refusing to rewrite immutable release file: ${filePath}`);
    }
    return;
  }

  await writeStableJson(filePath, payload);
}

async function readPointer(filePath) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.contractVersion !== WAVE1_RELEASE_POINTER_VERSION ||
    typeof parsed.appName !== "string" ||
    typeof parsed.releaseId !== "string" ||
    typeof parsed.updatedAt !== "string"
  ) {
    throw new Error(`Invalid release pointer at ${filePath}`);
  }

  return parsed;
}

async function writePointer(filePath, payload) {
  await writeStableJson(filePath, payload);
}

async function clearPointer(filePath) {
  await unlink(filePath).catch(() => undefined);
}

async function loadReleaseMetadata(rootDir, appName, releaseId) {
  const metadataFilePath = releaseMetadataPath(rootDir, appName, releaseId);
  const parsed = parseWave1ReleaseMetadata(
    await readFile(metadataFilePath, "utf8"),
  );

  if (parsed.issues.length > 0 || !parsed.metadata) {
    throw new Error(
      `Invalid release metadata at ${metadataFilePath}: ${JSON.stringify(parsed.issues)}`,
    );
  }

  return {
    metadata: parsed.metadata,
    metadataFilePath,
  };
}

async function writeReceipt(rootDir, appName, payload) {
  const receiptId = payload.receiptId ?? deriveReceiptId(payload);
  const fullPayload = {
    ...payload,
    contractVersion: WAVE1_RELEASE_RECEIPT_VERSION,
    receiptId,
  };
  const validation = validateWave1ReleaseReceipt(fullPayload);
  if (validation.issues.length > 0) {
    throw new Error(
      `Invalid release receipt payload: ${JSON.stringify(validation.issues)}`,
    );
  }
  const receiptPath = path.join(receiptsDirectory(rootDir, appName), `${receiptId}.json`);
  await writeImmutableJson(receiptPath, fullPayload);
  return {
    receiptId,
    receiptPath,
    receipt: fullPayload,
  };
}

export function getWave1ReleaseLayout(rootDir, appName, releaseId) {
  const metadataPath = releaseMetadataPath(rootDir, appName, releaseId);
  const releaseDir = releaseDirectory(rootDir, appName, releaseId);

  return {
    releaseRoot: releaseRoot(rootDir),
    appReleaseRoot: appReleaseRoot(rootDir, appName),
    releaseDirectory: releaseDir,
    releaseMetadataPath: metadataPath,
    currentPointerPath: currentPointerPath(rootDir, appName),
    previousPointerPath: previousPointerPath(rootDir, appName),
    receiptsDirectory: receiptsDirectory(rootDir, appName),
  };
}

export function getWave1ReleaseStatePaths(rootDir, appName) {
  return {
    currentPointerPath: currentPointerPath(rootDir, appName),
    previousPointerPath: previousPointerPath(rootDir, appName),
    receiptsDirectory: receiptsDirectory(rootDir, appName),
  };
}

export async function readWave1ReleaseState(rootDir, appName) {
  return {
    current: await readPointer(currentPointerPath(rootDir, appName)),
    previous: await readPointer(previousPointerPath(rootDir, appName)),
  };
}

export function planWave1Release(manifest, options = {}) {
  const releasePlan = buildWave1ReleasePlan(manifest, options);
  if (!releasePlan.releaseMetadata) {
    return releasePlan;
  }

  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const layout = getWave1ReleaseLayout(
    rootDir,
    releasePlan.appName,
    releasePlan.releaseId,
  );

  return {
    ...releasePlan,
    rootDir: normalizePath(rootDir),
    layout: {
      releaseDirectory: normalizeRelativePath(rootDir, layout.releaseDirectory),
      releaseMetadataPath: normalizeRelativePath(rootDir, layout.releaseMetadataPath),
      currentPointerPath: normalizeRelativePath(rootDir, layout.currentPointerPath),
      previousPointerPath: normalizeRelativePath(rootDir, layout.previousPointerPath),
      receiptsDirectory: normalizeRelativePath(rootDir, layout.receiptsDirectory),
    },
  };
}

export async function persistWave1Release(manifest, options = {}) {
  const releasePlan = planWave1Release(manifest, options);
  if (!releasePlan.releaseMetadata) {
    return releasePlan;
  }

  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const layout = getWave1ReleaseLayout(
    rootDir,
    releasePlan.appName,
    releasePlan.releaseId,
  );
  await mkdir(layout.releaseDirectory, { recursive: true });
  await mkdir(layout.receiptsDirectory, { recursive: true });
  await writeImmutableJson(
    layout.releaseMetadataPath,
    JSON.parse(serializeWave1ReleaseMetadata(releasePlan.releaseMetadata)),
  );

  const receiptAt =
    options.receiptAt ?? releasePlan.releaseMetadata.createdAt;
  const receiptResult = await writeReceipt(rootDir, releasePlan.appName, {
    action: "planned",
    status: "planned",
    appName: releasePlan.appName,
    releaseId: releasePlan.releaseId,
    createdAt: receiptAt,
    releaseDirectory: releasePlan.layout.releaseDirectory,
    releaseMetadataPath: releasePlan.layout.releaseMetadataPath,
    currentPointerPath: releasePlan.layout.currentPointerPath,
    previousPointerPath: releasePlan.layout.previousPointerPath,
    releaseTarget: releasePlan.releaseMetadata.releaseTarget,
    rollbackTarget: releasePlan.releaseMetadata.rollbackTarget,
    sourceAdapter: releasePlan.releaseMetadata.sourceAdapter,
  });

  return {
    ...releasePlan,
    receipt: {
      ...receiptResult.receipt,
      receiptPath: normalizeRelativePath(rootDir, receiptResult.receiptPath),
    },
  };
}

export async function activateWave1Release(
  rootDir,
  appName,
  releaseId,
  options = {},
) {
  const resolvedRoot = path.resolve(rootDir);
  const layout = getWave1ReleaseLayout(resolvedRoot, appName, releaseId);
  const { metadata } = await loadReleaseMetadata(resolvedRoot, appName, releaseId);
  const current = await readPointer(layout.currentPointerPath);
  const previous = await readPointer(layout.previousPointerPath);
  const receiptAt = options.receiptAt ?? metadata.createdAt;
  const preActivate = await runReleasePhase(
    resolvedRoot,
    "preActivate",
    getMigrationHookCommands(metadata.migrationHooks, "preActivate"),
  );

  if (preActivate.status !== "succeeded") {
    const failedReceipt = await writeReceipt(resolvedRoot, appName, {
      action: "activate",
      status: "failed",
      appName,
      releaseId,
      previousReleaseId: current?.releaseId,
      createdAt: receiptAt,
      releaseDirectory: normalizeRelativePath(resolvedRoot, layout.releaseDirectory),
      releaseMetadataPath: normalizeRelativePath(
        resolvedRoot,
        layout.releaseMetadataPath,
      ),
      currentPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.currentPointerPath,
      ),
      previousPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.previousPointerPath,
      ),
      releaseTarget: metadata.releaseTarget,
      rollbackTarget: metadata.rollbackTarget,
      phaseEvidence: {
        preActivate,
      },
      failedPhase: "preActivate",
      preservedCurrentReleaseId: current?.releaseId,
      preservedPreviousReleaseId: previous?.releaseId,
    });

    return {
      ok: false,
      phase: "preActivate",
      current,
      previous,
      receipt: {
        ...failedReceipt.receipt,
        receiptPath: normalizeRelativePath(resolvedRoot, failedReceipt.receiptPath),
      },
    };
  }

  const health =
    (await options.checkHealth?.({
      metadata,
      current,
      previous,
    })) ?? { ok: true, status: 200 };

  if (!health.ok) {
    const failedReceipt = await writeReceipt(resolvedRoot, appName, {
      action: "activate",
      status: "failed",
      appName,
      releaseId,
      previousReleaseId: current?.releaseId,
      createdAt: receiptAt,
      releaseDirectory: normalizeRelativePath(resolvedRoot, layout.releaseDirectory),
      releaseMetadataPath: normalizeRelativePath(
        resolvedRoot,
        layout.releaseMetadataPath,
      ),
      currentPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.currentPointerPath,
      ),
      previousPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.previousPointerPath,
      ),
      releaseTarget: metadata.releaseTarget,
      rollbackTarget: metadata.rollbackTarget,
      health,
      phaseEvidence: {
        preActivate,
      },
      failedPhase: "healthcheck",
      preservedCurrentReleaseId: current?.releaseId,
      preservedPreviousReleaseId: previous?.releaseId,
    });

    return {
      ok: false,
      phase: "healthcheck",
      health,
      current,
      previous,
      receipt: {
        ...failedReceipt.receipt,
        receiptPath: normalizeRelativePath(resolvedRoot, failedReceipt.receiptPath),
      },
    };
  }

  const nextPrevious = current && current.releaseId !== releaseId
    ? {
        contractVersion: WAVE1_RELEASE_POINTER_VERSION,
        appName,
        releaseId: current.releaseId,
        updatedAt: receiptAt,
        reason: "activation",
      }
    : previous;
  const nextCurrent = {
    contractVersion: WAVE1_RELEASE_POINTER_VERSION,
    appName,
    releaseId,
    updatedAt: receiptAt,
    reason: "activation",
  };

  await writePointer(layout.currentPointerPath, nextCurrent);
  if (nextPrevious) {
    await writePointer(layout.previousPointerPath, nextPrevious);
  } else {
    await clearPointer(layout.previousPointerPath);
  }

  const postActivate = await runReleasePhase(
    resolvedRoot,
    "postActivate",
    getMigrationHookCommands(metadata.migrationHooks, "postActivate"),
  );

  if (postActivate.status !== "succeeded") {
    await restoreReleasePointers(resolvedRoot, appName, current, previous);

    const failedReceipt = await writeReceipt(resolvedRoot, appName, {
      action: "activate",
      status: "failed",
      appName,
      releaseId,
      previousReleaseId: current?.releaseId,
      createdAt: receiptAt,
      releaseDirectory: normalizeRelativePath(resolvedRoot, layout.releaseDirectory),
      releaseMetadataPath: normalizeRelativePath(
        resolvedRoot,
        layout.releaseMetadataPath,
      ),
      currentPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.currentPointerPath,
      ),
      previousPointerPath: normalizeRelativePath(
        resolvedRoot,
        layout.previousPointerPath,
      ),
      releaseTarget: metadata.releaseTarget,
      rollbackTarget: metadata.rollbackTarget,
      health,
      phaseEvidence: {
        preActivate,
        postActivate,
      },
      failedPhase: "postActivate",
      preservedCurrentReleaseId: current?.releaseId,
      preservedPreviousReleaseId: previous?.releaseId,
      revertedPointers: true,
    });

    return {
      ok: false,
      phase: "postActivate",
      health,
      current,
      previous,
      receipt: {
        ...failedReceipt.receipt,
        receiptPath: normalizeRelativePath(resolvedRoot, failedReceipt.receiptPath),
      },
    };
  }

  const activationReceipt = await writeReceipt(resolvedRoot, appName, {
    action: "activate",
    status: "succeeded",
    appName,
    releaseId,
    previousReleaseId: current?.releaseId,
    createdAt: receiptAt,
    releaseDirectory: normalizeRelativePath(resolvedRoot, layout.releaseDirectory),
    releaseMetadataPath: normalizeRelativePath(
      resolvedRoot,
      layout.releaseMetadataPath,
    ),
    currentPointerPath: normalizeRelativePath(
      resolvedRoot,
      layout.currentPointerPath,
    ),
    previousPointerPath: normalizeRelativePath(
      resolvedRoot,
      layout.previousPointerPath,
    ),
    releaseTarget: metadata.releaseTarget,
    rollbackTarget: metadata.rollbackTarget,
    health,
    phaseEvidence: {
      preActivate,
      postActivate,
    },
    lineage: {
      promotedFromReleaseId: current?.releaseId,
      promotedToReleaseId: releaseId,
    },
  });

  return {
    ok: true,
    health,
    current: nextCurrent,
    previous: nextPrevious,
    receipt: {
      ...activationReceipt.receipt,
      receiptPath: normalizeRelativePath(resolvedRoot, activationReceipt.receiptPath),
    },
  };
}

export async function rollbackWave1Release(rootDir, appName, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const current = await readPointer(currentPointerPath(resolvedRoot, appName));
  const previous = await readPointer(previousPointerPath(resolvedRoot, appName));

  if (!current || !previous) {
    throw new Error(
      `Rollback requires both current and previous releases for ${appName}.`,
    );
  }

  const targetLayout = getWave1ReleaseLayout(
    resolvedRoot,
    appName,
    previous.releaseId,
  );
  const { metadata } = await loadReleaseMetadata(
    resolvedRoot,
    appName,
    previous.releaseId,
  );
  const preRollback = await runReleasePhase(
    resolvedRoot,
    "preRollback",
    getMigrationHookCommands(metadata.migrationHooks, "preRollback"),
  );

  if (preRollback.status !== "succeeded") {
    const failedReceipt = await writeReceipt(resolvedRoot, appName, {
      action: "rollback",
      status: "failed",
      appName,
      releaseId: previous.releaseId,
      previousReleaseId: current.releaseId,
      createdAt: options.receiptAt ?? metadata.createdAt,
      releaseDirectory: normalizeRelativePath(
        resolvedRoot,
        targetLayout.releaseDirectory,
      ),
      releaseMetadataPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.releaseMetadataPath,
      ),
      currentPointerPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.currentPointerPath,
      ),
      previousPointerPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.previousPointerPath,
      ),
      releaseTarget: metadata.releaseTarget,
      rollbackTarget: metadata.rollbackTarget,
      phaseEvidence: {
        preRollback,
      },
      failedPhase: "preRollback",
      preservedCurrentReleaseId: current.releaseId,
      preservedPreviousReleaseId: previous.releaseId,
    });

    return {
      ok: false,
      phase: "preRollback",
      current,
      previous,
      receipt: {
        ...failedReceipt.receipt,
        receiptPath: normalizeRelativePath(resolvedRoot, failedReceipt.receiptPath),
      },
    };
  }

  const health =
    (await options.checkHealth?.({
      metadata,
      current,
      previous,
    })) ?? { ok: true, status: 200 };
  const receiptAt = options.receiptAt ?? metadata.createdAt;

  if (!health.ok) {
    const failedReceipt = await writeReceipt(resolvedRoot, appName, {
      action: "rollback",
      status: "failed",
      appName,
      releaseId: previous.releaseId,
      previousReleaseId: current.releaseId,
      createdAt: receiptAt,
      releaseDirectory: normalizeRelativePath(
        resolvedRoot,
        targetLayout.releaseDirectory,
      ),
      releaseMetadataPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.releaseMetadataPath,
      ),
      currentPointerPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.currentPointerPath,
      ),
      previousPointerPath: normalizeRelativePath(
        resolvedRoot,
        targetLayout.previousPointerPath,
      ),
      releaseTarget: metadata.releaseTarget,
      rollbackTarget: metadata.rollbackTarget,
      health,
      phaseEvidence: {
        preRollback,
      },
      failedPhase: "healthcheck",
      preservedCurrentReleaseId: current.releaseId,
      preservedPreviousReleaseId: previous.releaseId,
    });

    return {
      ok: false,
      phase: "healthcheck",
      health,
      current,
      previous,
      receipt: {
        ...failedReceipt.receipt,
        receiptPath: normalizeRelativePath(resolvedRoot, failedReceipt.receiptPath),
      },
    };
  }

  const nextCurrent = {
    contractVersion: WAVE1_RELEASE_POINTER_VERSION,
    appName,
    releaseId: previous.releaseId,
    updatedAt: receiptAt,
    reason: "rollback",
  };
  const nextPrevious = {
    contractVersion: WAVE1_RELEASE_POINTER_VERSION,
    appName,
    releaseId: current.releaseId,
    updatedAt: receiptAt,
    reason: "rollback",
  };

  await writePointer(targetLayout.currentPointerPath, nextCurrent);
  await writePointer(targetLayout.previousPointerPath, nextPrevious);

  const rollbackReceipt = await writeReceipt(resolvedRoot, appName, {
    action: "rollback",
    status: "succeeded",
    appName,
    releaseId: previous.releaseId,
    previousReleaseId: current.releaseId,
    createdAt: receiptAt,
    releaseDirectory: normalizeRelativePath(
      resolvedRoot,
      targetLayout.releaseDirectory,
    ),
    releaseMetadataPath: normalizeRelativePath(
      resolvedRoot,
      targetLayout.releaseMetadataPath,
    ),
    currentPointerPath: normalizeRelativePath(
      resolvedRoot,
      targetLayout.currentPointerPath,
    ),
    previousPointerPath: normalizeRelativePath(
      resolvedRoot,
      targetLayout.previousPointerPath,
    ),
    releaseTarget: metadata.releaseTarget,
    rollbackTarget: metadata.rollbackTarget,
    health,
    phaseEvidence: {
      preRollback,
    },
    lineage: {
      promotedFromReleaseId: current.releaseId,
      promotedToReleaseId: previous.releaseId,
    },
  });

  return {
    ok: true,
    health,
    current: nextCurrent,
    previous: nextPrevious,
    receipt: {
      ...rollbackReceipt.receipt,
      receiptPath: normalizeRelativePath(resolvedRoot, rollbackReceipt.receiptPath),
    },
  };
}
