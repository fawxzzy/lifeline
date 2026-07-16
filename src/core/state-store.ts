import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getLifelineStateDirectory } from "./lifeline-root.js";

export type RuntimeStatus =
  | "running"
  | "stopped"
  | "unhealthy"
  | "crash-loop"
  | "blocked";
export type RestartPolicy = "on-failure" | "never";

export interface RuntimeAppState {
  name: string;
  manifestPath: string;
  playbookPath?: string | undefined;
  workingDirectory: string;
  supervisorPid: number;
  childPid?: number | undefined;
  wrapperPid?: number | undefined;
  listenerPid?: number | undefined;
  portOwnerPid?: number | undefined;
  port: number;
  healthcheckPath: string;
  logPath: string;
  startedAt: string;
  lastKnownStatus: RuntimeStatus;
  restartPolicy: RestartPolicy;
  restartCount: number;
  lastExitCode?: number | undefined;
  lastExitAt?: string | undefined;
  restorable: boolean;
  crashLoopDetected: boolean;
  blockedReason?: string | undefined;
}

export interface RuntimeStateFile {
  apps: Record<string, RuntimeAppState>;
}

export type ConditionalAppStateUpdateResult =
  | { updated: true; state: RuntimeAppState }
  | {
      updated: false;
      reason: "missing" | "supervisor-mismatch";
      state?: RuntimeAppState;
    };

interface StateMutationLeaseRecord {
  version: 1;
  ownerId: string;
  pid: number;
  startedAt: string;
}

interface StateMutationLease {
  directory: string;
  metadataPath: string;
  ownerId: string;
}

const STATE_MUTATION_LEASE_TIMEOUT_MS = 10_000;
const STATE_MUTATION_LEASE_POLL_MS = 25;

async function ensureStateDirectory(stateDirectory: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return (
    value === "running" ||
    value === "stopped" ||
    value === "unhealthy" ||
    value === "crash-loop" ||
    value === "blocked"
  );
}

function isRestartPolicy(value: unknown): value is RestartPolicy {
  return value === "on-failure" || value === "never";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

function isValidRuntimeAppState(value: unknown): value is RuntimeAppState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.name === "string" &&
    typeof candidate.manifestPath === "string" &&
    isOptionalString(candidate.playbookPath) &&
    typeof candidate.workingDirectory === "string" &&
    typeof candidate.supervisorPid === "number" &&
    Number.isInteger(candidate.supervisorPid) &&
    isOptionalInteger(candidate.childPid) &&
    isOptionalInteger(candidate.wrapperPid) &&
    isOptionalInteger(candidate.listenerPid) &&
    isOptionalInteger(candidate.portOwnerPid) &&
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    typeof candidate.healthcheckPath === "string" &&
    typeof candidate.logPath === "string" &&
    typeof candidate.startedAt === "string" &&
    isRuntimeStatus(candidate.lastKnownStatus) &&
    isRestartPolicy(candidate.restartPolicy) &&
    typeof candidate.restartCount === "number" &&
    Number.isInteger(candidate.restartCount) &&
    isOptionalInteger(candidate.lastExitCode) &&
    isOptionalString(candidate.lastExitAt) &&
    typeof candidate.restorable === "boolean" &&
    typeof candidate.crashLoopDetected === "boolean" &&
    isOptionalString(candidate.blockedReason)
  );
}

function sanitizeApps(value: unknown): Record<string, RuntimeAppState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const apps: Record<string, RuntimeAppState> = {};
  for (const [appName, appState] of Object.entries(value)) {
    if (isValidRuntimeAppState(appState)) {
      apps[appName] = appState;
    }
  }

  return apps;
}

export async function getStatePath(): Promise<string> {
  return path.join(getLifelineStateDirectory(), "state.json");
}

async function readStateUnlocked(): Promise<RuntimeStateFile> {
  const raw = await readFile(await getStatePath(), "utf8").catch(() => "");
  if (!raw) {
    return { apps: {} };
  }

  let parsed: Partial<RuntimeStateFile>;
  try {
    parsed = JSON.parse(raw) as Partial<RuntimeStateFile>;
  } catch {
    return { apps: {} };
  }

  return { apps: sanitizeApps(parsed.apps) };
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}

function stateMutationOwnerId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseStateMutationLeaseRecord(
  value: string,
): StateMutationLeaseRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StateMutationLeaseRecord>;
    return parsed.version === 1 &&
      typeof parsed.ownerId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string"
      ? (parsed as StateMutationLeaseRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForStateMutationLease(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STATE_MUTATION_LEASE_POLL_MS);
  });
}

async function acquireStateMutationLease(): Promise<StateMutationLease> {
  const stateDirectory = getLifelineStateDirectory();
  await ensureStateDirectory(stateDirectory);
  const directory = path.join(stateDirectory, "state.json.lock");
  const metadataPath = path.join(directory, "owner.json");
  const ownerId = stateMutationOwnerId();
  const deadline = Date.now() + STATE_MUTATION_LEASE_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    try {
      await mkdir(directory);
      const record: StateMutationLeaseRecord = {
        version: 1,
        ownerId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      try {
        await writeFile(
          metadataPath,
          `${JSON.stringify(record, null, 2)}\n`,
          "utf8",
        );
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return { directory, metadataPath, ownerId };
    } catch (error) {
      if (filesystemErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const [recordText, leaseStats] = await Promise.all([
      readFile(metadataPath, "utf8").catch(() => ""),
      stat(directory).catch(() => undefined),
    ]);
    const record = parseStateMutationLeaseRecord(recordText);
    const uninitializedLeaseExpired =
      !record &&
      leaseStats !== undefined &&
      Date.now() - leaseStats.mtimeMs >= STATE_MUTATION_LEASE_TIMEOUT_MS;
    if ((record && !isProcessAlive(record.pid)) || uninitializedLeaseExpired) {
      const staleDirectory = `${directory}.stale-${ownerId}`;
      try {
        await rename(directory, staleDirectory);
        await rm(staleDirectory, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (
          ![
            "ENOENT",
            "EEXIST",
            "ENOTEMPTY",
            "EPERM",
            "EACCES",
            "EBUSY",
          ].includes(filesystemErrorCode(error) ?? "")
        ) {
          throw error;
        }
      }
    }

    await waitForStateMutationLease();
  }

  throw new Error(
    `Timed out waiting for the runtime state mutation lease at ${directory}; the active lease was preserved for fail-closed recovery.`,
  );
}

async function releaseStateMutationLease(
  lease: StateMutationLease,
): Promise<void> {
  const record = parseStateMutationLeaseRecord(
    await readFile(lease.metadataPath, "utf8").catch(() => ""),
  );
  if (record?.ownerId !== lease.ownerId) {
    return;
  }
  const releaseDirectory = `${lease.directory}.release-${lease.ownerId}`;
  try {
    await rename(lease.directory, releaseDirectory);
    await rm(releaseDirectory, { recursive: true, force: true });
  } catch (error) {
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function withStateMutationLease<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireStateMutationLease();
  try {
    return await operation();
  } finally {
    await releaseStateMutationLease(lease);
  }
}

async function writeStateUnlocked(state: RuntimeStateFile): Promise<void> {
  const stateDirectory = getLifelineStateDirectory();
  const statePath = path.join(stateDirectory, "state.json");
  await ensureStateDirectory(stateDirectory);

  const serializedState = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = path.join(
    stateDirectory,
    `state.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await writeFile(tempPath, serializedState, "utf8");

  const fsPromises = (await import("node:fs/promises")) as unknown as {
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };

  try {
    await fsPromises.rename(tempPath, statePath);
  } catch (error) {
    await fsPromises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function readState(): Promise<RuntimeStateFile> {
  return readStateUnlocked();
}

export async function writeState(state: RuntimeStateFile): Promise<void> {
  await withStateMutationLease(async () => writeStateUnlocked(state));
}

export async function getAppState(
  appName: string,
): Promise<RuntimeAppState | undefined> {
  const state = await readState();
  return state.apps[appName];
}

export async function upsertAppState(appState: RuntimeAppState): Promise<void> {
  await withStateMutationLease(async () => {
    const state = await readStateUnlocked();
    state.apps[appState.name] = appState;
    await writeStateUnlocked(state);
  });
}

export async function updateAppStateIfSupervisorMatches(
  appName: string,
  expectedSupervisorPid: number,
  update: (
    currentState: RuntimeAppState,
  ) => RuntimeAppState | Promise<RuntimeAppState>,
): Promise<ConditionalAppStateUpdateResult> {
  return withStateMutationLease(async () => {
    const state = await readStateUnlocked();
    const currentState = state.apps[appName];
    if (!currentState) {
      return { updated: false, reason: "missing" };
    }
    if (currentState.supervisorPid !== expectedSupervisorPid) {
      return {
        updated: false,
        reason: "supervisor-mismatch",
        state: currentState,
      };
    }

    const nextState = await update(currentState);
    if (
      nextState.name !== appName ||
      nextState.supervisorPid !== expectedSupervisorPid
    ) {
      throw new Error(
        `Conditional runtime state update for ${appName} must preserve app and supervisor identity ${expectedSupervisorPid}.`,
      );
    }
    state.apps[appName] = nextState;
    await writeStateUnlocked(state);
    return { updated: true, state: nextState };
  });
}

export async function removeAppState(appName: string): Promise<void> {
  await withStateMutationLease(async () => {
    const state = await readStateUnlocked();
    delete state.apps[appName];
    await writeStateUnlocked(state);
  });
}
