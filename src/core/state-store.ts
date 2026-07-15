import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getLifelineStateDirectory } from "./lifeline-root.js";

export type RuntimeStatus = "running" | "stopped" | "unhealthy" | "crash-loop" | "blocked";
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
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
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

export async function readState(): Promise<RuntimeStateFile> {
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

export async function writeState(state: RuntimeStateFile): Promise<void> {
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

export async function getAppState(
  appName: string,
): Promise<RuntimeAppState | undefined> {
  const state = await readState();
  return state.apps[appName];
}

export async function upsertAppState(appState: RuntimeAppState): Promise<void> {
  const state = await readState();
  state.apps[appState.name] = appState;
  await writeState(state);
}

export async function removeAppState(appName: string): Promise<void> {
  const state = await readState();
  delete state.apps[appName];
  await writeState(state);
}
