import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveStartupBackend,
  type StartupBackend,
  type StartupBackendStatus,
} from "./startup-backend.js";
import { getLifelineStateDirectory } from "./lifeline-root.js";

export type StartupIntent = "enabled" | "disabled";

export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
  backendStatus: StartupBackendStatus;
  mechanism: string;
  detail: string;
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
}

export interface StartupPlan {
  action: "enable" | "disable";
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  backendStatus: StartupBackendStatus;
  detail: string;
}

function buildStartupRequest(dryRun: boolean) {
  return {
    scope: "machine-local" as const,
    restoreEntrypoint: "lifeline restore" as const,
    dryRun,
  };
}

function buildStartupStatusDetail(
  intent: StartupIntent,
  backendStatus: StartupBackendStatus,
  backendDetail: string,
  lastKnownBackendStatus: StartupBackendStatus,
) {
  if (backendStatus === "unsupported") {
    return `Startup intent is ${intent} in Lifeline state. Backend reports unsupported on this platform. ${backendDetail}`;
  }

  const intentMatchesBackend =
    (intent === "enabled" && backendStatus === "installed") ||
    (intent === "disabled" && backendStatus !== "installed");

  const intentDetail = intentMatchesBackend
    ? `Startup intent is ${intent} in Lifeline state.`
    : `Startup intent is ${intent} in Lifeline state but backend inspection is ${backendStatus}.`;

  const persistenceDetail =
    lastKnownBackendStatus === backendStatus
      ? "Persisted startup backend status matches backend inspection."
      : `Persisted startup backend status is ${lastKnownBackendStatus} while backend inspection is ${backendStatus}.`;

  return `${intentDetail} ${persistenceDetail} ${backendDetail}`;
}

interface StartupState {
  version: 1;
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  intent: StartupIntent;
  backendStatus: StartupBackendStatus;
  updatedAt: string;
}

function defaultState(): StartupState {
  return {
    version: 1,
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    intent: "disabled",
    backendStatus: "not-installed",
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIntent(value: unknown): StartupIntent {
  return value === "enabled" ? "enabled" : "disabled";
}

function sanitizeUpdatedAt(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return value;
  }

  return new Date().toISOString();
}

function sanitizeBackendStatus(value: unknown): StartupBackendStatus {
  if (value === "installed" || value === "unsupported" || value === "not-installed") {
    return value;
  }

  return "not-installed";
}

async function readStartupState(): Promise<StartupState> {
  const startupStatePath = path.join(
    getLifelineStateDirectory(),
    "startup.json",
  );
  const raw = await readFile(startupStatePath, "utf8").catch(() => "");
  if (!raw) {
    return defaultState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultState();
  }

  if (!isRecord(parsed)) {
    return defaultState();
  }

  return {
    version: 1,
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    backendStatus: sanitizeBackendStatus(parsed.backendStatus),
    intent: sanitizeIntent(parsed.intent),
    updatedAt: sanitizeUpdatedAt(parsed.updatedAt),
  };
}

async function writeStartupState(state: StartupState): Promise<void> {
  const stateDirectory = getLifelineStateDirectory();
  const startupStatePath = path.join(stateDirectory, "startup.json");
  await mkdir(stateDirectory, { recursive: true });

  const serializedState = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = path.join(
    stateDirectory,
    `startup.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await writeFile(tempPath, serializedState, "utf8");

  const fsPromises = (await import("node:fs/promises")) as unknown as {
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };

  try {
    await fsPromises.rename(tempPath, startupStatePath);
  } catch (error) {
    await fsPromises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function planStartupAction(
  action: "enable" | "disable",
  backend: StartupBackend = resolveStartupBackend(),
): Promise<StartupPlan> {
  const request = buildStartupRequest(true);

  const preview = action === "enable" ? await backend.install(request) : await backend.uninstall(request);

  return {
    action,
    scope: request.scope,
    restoreEntrypoint: request.restoreEntrypoint,
    backendStatus: preview.status,
    detail: preview.detail,
  };
}

export function createStartupMutationRequest() {
  return buildStartupRequest(false);
}

export async function setStartupIntent(
  intent: StartupIntent,
  backendStatus: StartupBackendStatus = "not-installed",
): Promise<void> {
  const current = await readStartupState();
  await writeStartupState({
    ...current,
    intent,
    backendStatus,
    updatedAt: new Date().toISOString(),
  });
}

export async function getStartupStatus(
  backend: StartupBackend = resolveStartupBackend(),
): Promise<StartupStatus> {
  const state = await readStartupState();
  const inspection = await backend.inspect();
  const backendEnabled = inspection.status === "installed";

  return {
    supported: inspection.supported,
    enabled: backendEnabled,
    backendStatus: inspection.status,
    mechanism: inspection.mechanism,
    detail: buildStartupStatusDetail(
      state.intent,
      inspection.status,
      inspection.detail,
      state.backendStatus,
    ),
    scope: state.scope,
    restoreEntrypoint: state.restoreEntrypoint,
  };
}
