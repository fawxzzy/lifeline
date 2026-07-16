import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const execFileAsync = promisify(execFile);

function createAppState(name, supervisorPid, lastKnownStatus = "running") {
  return {
    name,
    manifestPath: `/manifests/${name}.mjs`,
    playbookPath: undefined,
    workingDirectory: "/tmp",
    supervisorPid,
    childPid: undefined,
    wrapperPid: undefined,
    listenerPid: undefined,
    portOwnerPid: undefined,
    port: 9000,
    healthcheckPath: "/healthz",
    logPath: `/logs/${name}.log`,
    startedAt: new Date(0).toISOString(),
    lastKnownStatus,
    restartPolicy: "on-failure",
    restartCount: 0,
    lastExitCode: undefined,
    lastExitAt: undefined,
    restorable: true,
    crashLoopDetected: false,
    blockedReason: undefined,
  };
}

async function waitForFile(filePath, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await access(filePath)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label} at ${filePath}.`);
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-runtime-state-atomic-"),
);
const originalCwd = process.cwd();

try {
  process.chdir(tempRoot);

  const stateStoreModule = await import(
    new URL("../dist/core/state-store.js", import.meta.url)
  );
  const {
    getStatePath,
    readState,
    updateAppStateIfSupervisorMatches,
    upsertAppState,
  } = stateStoreModule;

  const appName = "atomic-runtime-state-check";
  const writeCount = 200;

  for (let index = 0; index < writeCount; index += 1) {
    await upsertAppState({
      name: appName,
      manifestPath: `/manifests/${appName}.mjs`,
      playbookPath: undefined,
      workingDirectory: "/tmp",
      supervisorPid: 4200 + index,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      port: 9000,
      healthcheckPath: "/healthz",
      logPath: `/logs/${appName}.log`,
      startedAt: new Date(0).toISOString(),
      lastKnownStatus: index % 2 === 0 ? "running" : "unhealthy",
      restartPolicy: "on-failure",
      restartCount: index,
      lastExitCode: index,
      lastExitAt: undefined,
      restorable: true,
      crashLoopDetected: false,
      blockedReason: undefined,
    });
  }

  const statePath = await getStatePath();
  const rawState = await readFile(statePath, "utf8");

  if (!rawState.endsWith("\n")) {
    throw new Error(
      "Expected runtime state file to preserve trailing newline formatting.",
    );
  }

  let parsedState;
  try {
    parsedState = JSON.parse(rawState);
  } catch (error) {
    throw new Error(
      `Expected valid JSON in final runtime state file. Error: ${String(error)}`,
    );
  }

  const finalAppState = parsedState?.apps?.[appName];
  if (!finalAppState) {
    throw new Error(
      `Expected app ${appName} to be present in persisted runtime state.`,
    );
  }

  if (finalAppState.restartCount !== writeCount - 1) {
    throw new Error(
      `Expected restartCount ${writeCount - 1}, received ${String(finalAppState.restartCount)}.`,
    );
  }

  if (finalAppState.supervisorPid !== 4200 + (writeCount - 1)) {
    throw new Error(
      `Expected supervisorPid ${4200 + (writeCount - 1)}, received ${String(finalAppState.supervisorPid)}.`,
    );
  }

  const loadedState = await readState();
  if (loadedState.apps[appName]?.restartCount !== writeCount - 1) {
    throw new Error(
      "Expected readState() to return final persisted runtime state values.",
    );
  }

  const replacementFirstApp = "replacement-wins-before-conditional";
  await upsertAppState(createAppState(replacementFirstApp, 7100));
  await upsertAppState(createAppState(replacementFirstApp, 7200));
  const replacementFirstResult = await updateAppStateIfSupervisorMatches(
    replacementFirstApp,
    7100,
    (currentState) => ({
      ...currentState,
      lastKnownStatus: "stopped",
      lastExitAt: new Date().toISOString(),
    }),
  );
  const replacementFirstState = (await readState()).apps[replacementFirstApp];
  if (
    replacementFirstResult.updated !== false ||
    replacementFirstResult.reason !== "supervisor-mismatch" ||
    replacementFirstState?.supervisorPid !== 7200 ||
    replacementFirstState.lastKnownStatus !== "running"
  ) {
    throw new Error(
      "A replacement state that wins before the conditional transition must remain current and untouched.",
    );
  }

  const boundaryApp = "replacement-races-check-write-boundary";
  const originalSupervisorPid = 8100;
  const replacementSupervisorPid = 8200;
  await upsertAppState(createAppState(boundaryApp, originalSupervisorPid));

  const markerPath = path.join(tempRoot, "conditional-check-complete.marker");
  const releasePath = path.join(tempRoot, "release-conditional.marker");
  const stateStoreUrl = new URL("../dist/core/state-store.js", import.meta.url)
    .href;
  const replacementState = createAppState(
    boundaryApp,
    replacementSupervisorPid,
  );
  const childEnvironment = {
    ...process.env,
    LIFELINE_ROOT: tempRoot,
  };
  const conditionalScript = `
    import { access, writeFile } from "node:fs/promises";
    import { updateAppStateIfSupervisorMatches } from ${JSON.stringify(stateStoreUrl)};
    const markerPath = ${JSON.stringify(markerPath)};
    const releasePath = ${JSON.stringify(releasePath)};
    const result = await updateAppStateIfSupervisorMatches(
      ${JSON.stringify(boundaryApp)},
      ${originalSupervisorPid},
      async (currentState) => {
        await writeFile(markerPath, "checked", "utf8");
        while (!(await access(releasePath).then(() => true).catch(() => false))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          ...currentState,
          lastKnownStatus: "stopped",
          lastExitAt: new Date().toISOString(),
        };
      },
    );
    if (!result.updated) process.exit(2);
  `;
  const replacementScript = `
    import { upsertAppState } from ${JSON.stringify(stateStoreUrl)};
    await upsertAppState(${JSON.stringify(replacementState)});
  `;

  const conditionalProcess = execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", conditionalScript],
    { env: childEnvironment },
  );
  await waitForFile(markerPath, "conditional state comparison");

  let replacementCompleted = false;
  const replacementProcess = execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", replacementScript],
    { env: childEnvironment },
  ).then((result) => {
    replacementCompleted = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (replacementCompleted) {
    throw new Error(
      "A replacement writer crossed the conditional check/write transaction boundary instead of waiting on the shared state-store lease.",
    );
  }
  await writeFile(releasePath, "release", "utf8");
  await Promise.all([conditionalProcess, replacementProcess]);

  const boundaryFinalState = (await readState()).apps[boundaryApp];
  if (
    boundaryFinalState?.supervisorPid !== replacementSupervisorPid ||
    boundaryFinalState.lastKnownStatus !== "running"
  ) {
    throw new Error(
      `Expected queued replacement supervisor ${replacementSupervisorPid} to remain current after the invocation-owned conditional transition, found ${JSON.stringify(boundaryFinalState)}.`,
    );
  }
  const lockResidue = (await readdir(path.join(tempRoot, ".lifeline"))).filter(
    (name) => name.startsWith("state.json.lock"),
  );
  if (lockResidue.length !== 0) {
    throw new Error(
      `Expected state mutation lease cleanup after cross-process interleaving, found ${lockResidue.join(", ")}.`,
    );
  }

  console.log(
    "Runtime state atomic and supervisor-conditional write deterministic verification passed.",
  );
} finally {
  process.chdir(originalCwd);
}
