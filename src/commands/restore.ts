import {
  isProcessAlive,
  startDetachedExecutable,
} from "../core/process-manager.js";
import {
  readState,
  type RuntimeStateFile,
  upsertAppState,
} from "../core/state-store.js";
import { prepareRuntimeApp } from "./up.js";

const STARTUP_TERMINAL_TIMEOUT_MS = 20_000;

export interface RestoredStartupApp {
  name: string;
  supervisorPid: number;
  startedAt: string;
}

export interface RestoreCommandOptions {
  startup?: boolean;
}

export function isPersistedStatusEligibleForRestore(
  status: "running" | "stopped" | "unhealthy" | "crash-loop" | "blocked",
  options: RestoreCommandOptions = {},
): boolean {
  return (
    status === "running" ||
    status === "unhealthy" ||
    (options.startup === true && status === "stopped")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function holdStartupRestoreWrapper(
  restoredSupervisorPids: number[],
): Promise<void> {
  console.log(
    `Startup restore wrapper is holding for supervisor pids ${restoredSupervisorPids.join(", ")}.`,
  );
  while (true) {
    const alive = await Promise.all(
      restoredSupervisorPids.map((pid) => isProcessAlive(pid)),
    );
    if (alive.every((value) => !value)) {
      return;
    }
    await delay(500);
  }
}

export function getStartupRestoreTerminalFailure(
  restoredApps: RestoredStartupApp[],
  state: RuntimeStateFile,
): string | undefined {
  for (const restored of restoredApps) {
    const app = state.apps[restored.name];
    if (!app) {
      return `${restored.name} runtime state is missing`;
    }
    if (app.supervisorPid !== restored.supervisorPid) {
      return `${restored.name} supervisor identity changed from ${restored.supervisorPid} to ${app.supervisorPid}`;
    }
    if (app.lastKnownStatus !== "stopped") {
      return `${restored.name} persisted status is ${app.lastKnownStatus}, not stopped`;
    }
    if (
      app.childPid !== undefined ||
      app.wrapperPid !== undefined ||
      app.listenerPid !== undefined ||
      app.portOwnerPid !== undefined
    ) {
      return `${restored.name} stopped state still contains a managed process identity`;
    }
    if (app.blockedReason !== undefined || app.crashLoopDetected) {
      return `${restored.name} stopped state retains a failure marker`;
    }
    const restoredAt = Date.parse(restored.startedAt);
    const exitedAt = Date.parse(app.lastExitAt ?? "");
    if (
      !Number.isFinite(restoredAt) ||
      !Number.isFinite(exitedAt) ||
      exitedAt < restoredAt
    ) {
      return `${restored.name} stopped state lacks a terminal timestamp for this restore`;
    }
  }

  return undefined;
}

async function waitForStartupRestoreTerminalState(
  restoredApps: RestoredStartupApp[],
): Promise<string | undefined> {
  const deadline = Date.now() + STARTUP_TERMINAL_TIMEOUT_MS;
  let failure = "startup terminal state was not inspected";
  while (Date.now() <= deadline) {
    failure =
      getStartupRestoreTerminalFailure(restoredApps, await readState()) ?? "";
    if (!failure) {
      return undefined;
    }
    await delay(250);
  }
  return failure;
}

export async function runRestoreCommand(
  options: RestoreCommandOptions = {},
): Promise<number> {
  const state = await readState();
  const apps = Object.values(state.apps);
  if (apps.length === 0) {
    console.log("No managed apps found in .lifeline/state.json.");
    return 0;
  }

  let restored = 0;
  let failures = 0;
  const restoredSupervisorPids: number[] = [];
  const restoredStartupApps: RestoredStartupApp[] = [];
  for (const app of apps) {
    if (!app.restorable) {
      const reason = "app is marked restorable=false.";
      console.log(`Skipping ${app.name}: ${reason}`);
      continue;
    }

    if (await isProcessAlive(app.supervisorPid)) {
      console.log(
        `Skipping ${app.name}: supervisor already running (pid ${app.supervisorPid}).`,
      );
      continue;
    }

    if (!isPersistedStatusEligibleForRestore(app.lastKnownStatus, options)) {
      console.log(
        `Skipping ${app.name}: last known status is ${app.lastKnownStatus}; not restorable as running.`,
      );
      continue;
    }

    try {
      await prepareRuntimeApp(app.manifestPath, app.playbookPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await upsertAppState({
        ...app,
        childPid: undefined,
        wrapperPid: undefined,
        listenerPid: undefined,
        portOwnerPid: undefined,
        blockedReason: undefined,
        lastKnownStatus: "stopped",
        crashLoopDetected: false,
      });
      console.error(`Failed to restore ${app.name}: ${message}`);
      failures += 1;
      continue;
    }

    const cliPath = process.argv[1] ?? "dist/cli.js";
    const startedAt = new Date().toISOString();
    const supervisorPid = await startDetachedExecutable({
      executable: process.execPath,
      args: [cliPath, "supervise", app.name],
      cwd: process.cwd(),
      env: process.env,
      label: `${app.name} supervisor`,
    });

    await upsertAppState({
      ...app,
      supervisorPid,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      blockedReason: undefined,
      startedAt,
      lastKnownStatus: "stopped",
      crashLoopDetected: false,
      lastExitCode: undefined,
      lastExitAt: undefined,
    });

    console.log(`Restored ${app.name} with supervisor pid ${supervisorPid}.`);
    restoredSupervisorPids.push(supervisorPid);
    restoredStartupApps.push({ name: app.name, supervisorPid, startedAt });
    restored += 1;
  }

  if (restored === 0) {
    console.log("No restorable apps required restart.");
  }

  if (
    options.startup === true &&
    failures === 0 &&
    restoredSupervisorPids.length > 0
  ) {
    await holdStartupRestoreWrapper(restoredSupervisorPids);
    const terminalFailure = await waitForStartupRestoreTerminalState(
      restoredStartupApps,
    );
    if (terminalFailure) {
      console.error(`Startup restore failed closed: ${terminalFailure}.`);
      return 1;
    }
  }

  return failures > 0 ? 1 : 0;
}
