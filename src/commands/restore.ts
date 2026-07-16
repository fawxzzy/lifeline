import {
  isProcessAlive,
  startDetachedExecutable,
  stopProcess,
} from "../core/process-manager.js";
import {
  type RuntimeStateFile,
  readState,
  upsertAppState,
} from "../core/state-store.js";
import { runDownCommand } from "./down.js";
import { prepareRuntimeApp } from "./up.js";

const STARTUP_TERMINAL_TIMEOUT_MS = 20_000;
const STARTUP_TERMINAL_GRACE_MS = 2_000;

export interface RestoredStartupApp {
  name: string;
  supervisorPid: number;
  startedAt: string;
}

export interface RestoreCommandOptions {
  startup?: boolean;
}

export interface StartupRestoreCleanupDependencies {
  downApp?: (appName: string) => Promise<number>;
  processAlive?: (pid: number) => Promise<boolean>;
  readRuntimeState?: () => Promise<RuntimeStateFile>;
  stopSupervisor?: (pid: number) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type StartupRestoreMonitorDependencies =
  StartupRestoreCleanupDependencies;

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

export async function holdStartupRestoreWrapper(
  restoredApps: RestoredStartupApp[],
  dependencies: StartupRestoreMonitorDependencies = {},
): Promise<string | undefined> {
  const processAlive = dependencies.processAlive ?? isProcessAlive;
  const readRuntimeState = dependencies.readRuntimeState ?? readState;
  const wait = dependencies.wait ?? delay;
  const now = dependencies.now ?? Date.now;
  const deadSince = new Map<number, number>();
  console.log(
    `Startup restore wrapper is holding for supervisor pids ${restoredApps.map((app) => app.supervisorPid).join(", ")}.`,
  );
  while (true) {
    let state: RuntimeStateFile;
    let alive: boolean[];
    try {
      [state, alive] = await Promise.all([
        readRuntimeState(),
        Promise.all(restoredApps.map((app) => processAlive(app.supervisorPid))),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `startup hold inspection failed: ${message}`;
    }

    let pendingTerminalFailure: string | undefined;
    for (const [index, restored] of restoredApps.entries()) {
      const app = state.apps[restored.name];
      if (!app) {
        return `${restored.name} runtime state is missing during startup hold`;
      }
      if (app.supervisorPid !== restored.supervisorPid) {
        return `${restored.name} supervisor identity changed from ${restored.supervisorPid} to ${app.supervisorPid} during startup hold`;
      }
      if (
        app.lastKnownStatus === "blocked" ||
        app.lastKnownStatus === "crash-loop" ||
        app.lastKnownStatus === "unhealthy" ||
        app.blockedReason !== undefined ||
        app.crashLoopDetected
      ) {
        return `${restored.name} entered ${app.lastKnownStatus} during startup hold`;
      }
      if (!alive[index]) {
        const terminalFailure = getStartupRestoreTerminalFailure(
          [restored],
          state,
        );
        if (terminalFailure) {
          const firstDeadAt = deadSince.get(restored.supervisorPid) ?? now();
          deadSince.set(restored.supervisorPid, firstDeadAt);
          if (now() - firstDeadAt >= STARTUP_TERMINAL_GRACE_MS) {
            return terminalFailure;
          }
          pendingTerminalFailure ??= terminalFailure;
        } else {
          deadSince.delete(restored.supervisorPid);
        }
      } else {
        deadSince.delete(restored.supervisorPid);
      }
    }

    if (
      alive.every((value) => !value) &&
      pendingTerminalFailure === undefined
    ) {
      return undefined;
    }
    await wait(500);
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
  readRuntimeState: () => Promise<RuntimeStateFile> = readState,
  wait: (ms: number) => Promise<void> = delay,
  now: () => number = Date.now,
): Promise<string | undefined> {
  const deadline = now() + STARTUP_TERMINAL_TIMEOUT_MS;
  let failure = "startup terminal state was not inspected";
  while (now() <= deadline) {
    let state: RuntimeStateFile;
    try {
      state = await readRuntimeState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `startup terminal state inspection failed: ${message}`;
    }
    failure = getStartupRestoreTerminalFailure(restoredApps, state) ?? "";
    if (!failure) {
      return undefined;
    }
    await wait(250);
  }
  return failure;
}

export async function cleanupPartialStartupRestore(
  restoredApps: RestoredStartupApp[],
  dependencies: StartupRestoreCleanupDependencies = {},
): Promise<string | undefined> {
  const downApp = dependencies.downApp;
  const processAlive = dependencies.processAlive ?? isProcessAlive;
  const readRuntimeState = dependencies.readRuntimeState ?? readState;
  const stopSupervisor = dependencies.stopSupervisor ?? stopProcess;
  const wait = dependencies.wait ?? delay;
  const now = dependencies.now ?? Date.now;
  const cleanupFailures: string[] = [];
  const preservedReplacements = new Map<string, number>();

  for (const restored of [...restoredApps].reverse()) {
    let currentState: RuntimeStateFile;
    try {
      currentState = await readRuntimeState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupFailures.push(
        `${restored.name} pre-down state inspection failed: ${message}`,
      );
      continue;
    }
    const currentApp = currentState.apps[restored.name];
    if (!currentApp) {
      cleanupFailures.push(
        `${restored.name} pre-down runtime state is missing`,
      );
      continue;
    }
    if (currentApp.supervisorPid !== restored.supervisorPid) {
      preservedReplacements.set(restored.name, currentApp.supervisorPid);
      console.log(
        `Startup cleanup preserved replacement supervisor ${currentApp.supervisorPid} for ${restored.name}; stopping only invocation-owned supervisor ${restored.supervisorPid}.`,
      );
      continue;
    }
    const exitCode = await (downApp
      ? downApp(restored.name)
      : runDownCommand(restored.name, {
          expectedSupervisorPid: restored.supervisorPid,
        })
    ).catch(() => 1);
    if (exitCode !== 0) {
      cleanupFailures.push(`${restored.name} down exited ${exitCode}`);
    }
  }

  const deadline = now() + STARTUP_TERMINAL_TIMEOUT_MS;
  let alive = restoredApps.filter(() => false);
  do {
    alive = [];
    for (const restored of restoredApps) {
      let isAlive = false;
      try {
        isAlive = await processAlive(restored.supervisorPid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupFailures.push(
          `${restored.name} supervisor liveness inspection failed: ${message}`,
        );
        await stopSupervisor(restored.supervisorPid).catch(() => undefined);
      }
      if (isAlive) {
        alive.push(restored);
        await stopSupervisor(restored.supervisorPid).catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          cleanupFailures.push(
            `${restored.name} supervisor stop failed: ${message}`,
          );
        });
      }
    }
    if (alive.length > 0) {
      await wait(250);
    }
  } while (alive.length > 0 && now() <= deadline);

  const stillAlive: RestoredStartupApp[] = [];
  for (const restored of restoredApps) {
    await processAlive(restored.supervisorPid).then(
      (isAlive) => {
        if (isAlive) {
          stillAlive.push(restored);
        }
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        cleanupFailures.push(
          `${restored.name} final supervisor liveness readback failed: ${message}`,
        );
      },
    );
  }
  if (stillAlive.length > 0) {
    cleanupFailures.push(
      `supervisor pids still alive: ${stillAlive.map((app) => app.supervisorPid).join(", ")}`,
    );
  }

  const sameSupervisorApps = restoredApps.filter(
    (restored) => !preservedReplacements.has(restored.name),
  );
  const terminalFailure =
    sameSupervisorApps.length > 0
      ? await waitForStartupRestoreTerminalState(
          sameSupervisorApps,
          readRuntimeState,
          wait,
          now,
        )
      : undefined;
  if (terminalFailure) {
    cleanupFailures.push(terminalFailure);
  }

  if (preservedReplacements.size > 0) {
    let finalState: RuntimeStateFile | undefined;
    try {
      finalState = await readRuntimeState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupFailures.push(
        `replacement supervisor state readback failed: ${message}`,
      );
    }
    if (finalState) {
      for (const restored of restoredApps) {
        const replacementPid = preservedReplacements.get(restored.name);
        if (replacementPid === undefined) {
          continue;
        }
        const finalApp = finalState.apps[restored.name];
        if (finalApp?.supervisorPid !== replacementPid) {
          cleanupFailures.push(
            `${restored.name} replacement supervisor state changed from ${replacementPid} to ${finalApp?.supervisorPid ?? "missing"} during cleanup verification`,
          );
        }
      }
    }
  }
  return cleanupFailures.length > 0 ? cleanupFailures.join("; ") : undefined;
}

export async function monitorStartupRestore(
  restoredApps: RestoredStartupApp[],
  dependencies: StartupRestoreMonitorDependencies = {},
): Promise<string | undefined> {
  const holdFailure = await holdStartupRestoreWrapper(
    restoredApps,
    dependencies,
  );
  const terminalFailure =
    holdFailure ??
    (await waitForStartupRestoreTerminalState(
      restoredApps,
      dependencies.readRuntimeState ?? readState,
      dependencies.wait ?? delay,
      dependencies.now ?? Date.now,
    ));
  if (!terminalFailure) {
    return undefined;
  }

  const cleanupFailure = await cleanupPartialStartupRestore(
    restoredApps,
    dependencies,
  );
  return cleanupFailure
    ? `${terminalFailure}; cleanup failed: ${cleanupFailure}`
    : `${terminalFailure}; all supervisors started by this invocation were stopped and verified`;
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
      if (options.startup === true) {
        break;
      }
      continue;
    }

    const cliPath = process.argv[1] ?? "dist/cli.js";
    const startedAt = new Date().toISOString();
    let supervisorPid: number;
    try {
      supervisorPid = await startDetachedExecutable({
        executable: process.execPath,
        args: [cliPath, "supervise", app.name],
        cwd: process.cwd(),
        env: process.env,
        label: `${app.name} supervisor`,
      });
      restoredSupervisorPids.push(supervisorPid);
      restoredStartupApps.push({ name: app.name, supervisorPid, startedAt });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to restore ${app.name}: ${message}`);
      failures += 1;
      if (options.startup === true) {
        break;
      }
      continue;
    }

    console.log(`Restored ${app.name} with supervisor pid ${supervisorPid}.`);
    restored += 1;
  }

  if (restored === 0 && restoredStartupApps.length === 0) {
    console.log("No restorable apps required restart.");
  }

  if (options.startup === true && restoredSupervisorPids.length > 0) {
    if (failures > 0) {
      const cleanupFailure =
        await cleanupPartialStartupRestore(restoredStartupApps);
      if (cleanupFailure) {
        console.error(
          `Partial startup restore cleanup failed: ${cleanupFailure}.`,
        );
      } else {
        console.error(
          "Partial startup restore was stopped and terminal state was verified.",
        );
      }
      return 1;
    }
    const terminalFailure = await monitorStartupRestore(restoredStartupApps);
    if (terminalFailure) {
      console.error(`Startup restore failed closed: ${terminalFailure}.`);
      return 1;
    }
  }

  return failures > 0 ? 1 : 0;
}
