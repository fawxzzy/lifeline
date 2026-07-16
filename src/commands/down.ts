import {
  findListeningPortOwnerPid,
  isProcessAlive,
  stopProcess,
  waitForPortToClear,
} from "../core/process-manager.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

const PORT_CLEAR_TIMEOUT_MS = 12_000;

export interface DownCommandOptions {
  expectedSupervisorPid?: number;
}

async function writeDownStateIfStillOwned(
  appName: string,
  expectedSupervisorPid: number | undefined,
  nextState: NonNullable<Awaited<ReturnType<typeof getAppState>>>,
): Promise<boolean> {
  if (expectedSupervisorPid !== undefined) {
    const currentState = await getAppState(appName);
    if (currentState?.supervisorPid !== expectedSupervisorPid) {
      console.error(
        `App ${appName} supervisor identity changed from ${expectedSupervisorPid} to ${currentState?.supervisorPid ?? "missing"}; refusing to overwrite replacement state.`,
      );
      return false;
    }
  }

  await upsertAppState(nextState);
  return true;
}

export async function runDownCommand(
  appName: string,
  options: DownCommandOptions = {},
): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }
  if (
    options.expectedSupervisorPid !== undefined &&
    state.supervisorPid !== options.expectedSupervisorPid
  ) {
    console.error(
      `App ${appName} supervisor identity changed from ${options.expectedSupervisorPid} to ${state.supervisorPid}; refusing to stop a replacement supervisor.`,
    );
    return 1;
  }

  const trackedPids = [
    state.supervisorPid,
    state.wrapperPid,
    state.listenerPid,
    state.childPid,
  ].filter((pid): pid is number => Number.isInteger(pid));
  const uniqueTrackedPids = [...new Set(trackedPids)];

  for (const pid of uniqueTrackedPids) {
    if (await isProcessAlive(pid)) {
      await stopProcess(pid);
    }
  }

  const remainingOwnerPid = await findListeningPortOwnerPid(state.port);
  const trackedPidSet = new Set(uniqueTrackedPids);

  if (
    remainingOwnerPid &&
    trackedPidSet.has(remainingOwnerPid) &&
    (await isProcessAlive(remainingOwnerPid))
  ) {
    await stopProcess(remainingOwnerPid);
  }

  const portReleased = await waitForPortToClear(
    state.port,
    PORT_CLEAR_TIMEOUT_MS,
  );
  if (!portReleased) {
    const blockedOwnerPid = await findListeningPortOwnerPid(state.port);
    const blockedReason = blockedOwnerPid
      ? `down failed: port ${state.port} still occupied by pid ${blockedOwnerPid}`
      : `down failed: port ${state.port} did not clear within ${PORT_CLEAR_TIMEOUT_MS}ms`;

    const wroteBlockedState = await writeDownStateIfStillOwned(
      appName,
      options.expectedSupervisorPid,
      {
        ...state,
        childPid: undefined,
        wrapperPid: undefined,
        listenerPid: undefined,
        portOwnerPid: blockedOwnerPid,
        blockedReason,
        lastKnownStatus: "blocked",
        lastExitAt: new Date().toISOString(),
      },
    );
    if (!wroteBlockedState) {
      return 1;
    }

    console.error(
      `App ${appName} could not be fully stopped: ${blockedReason}.`,
    );
    return 1;
  }

  const wroteStoppedState = await writeDownStateIfStillOwned(
    appName,
    options.expectedSupervisorPid,
    {
      ...state,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      blockedReason: undefined,
      crashLoopDetected: false,
      lastKnownStatus: "stopped",
      lastExitAt: new Date().toISOString(),
    },
  );
  if (!wroteStoppedState) {
    return 1;
  }
  console.log(`App ${appName} has been stopped.`);
  return 0;
}
