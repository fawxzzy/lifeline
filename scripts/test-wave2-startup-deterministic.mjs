import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureBuiltCli() {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  try {
    await access(cliPath);
  } catch {
    await execFileAsync("pnpm", ["build"], {
      cwd: repoRoot,
      env: process.env,
    });
  }
}

async function verifyRestoreEntrypointWiring() {
  const cliSource = await readFile(
    new URL("../src/cli.ts", import.meta.url),
    "utf8",
  );

  assert(
    cliSource.includes("runRestoreCommand") &&
      cliSource.includes('case "restore":'),
    "Expected src/cli.ts to keep restore entrypoint wired through runRestoreCommand.",
  );

  assert(
    cliSource.includes("lifeline [--root <path>] restore [--startup]") &&
      cliSource.includes(
        'runRestoreCommand({ startup: target === "--startup" })',
      ),
    "Expected CLI usage output to keep the restore command discoverable.",
  );

  await ensureBuiltCli();
  const {
    cleanupPartialStartupRestore,
    getStartupRestoreTerminalFailure,
    holdStartupRestoreWrapper,
    isPersistedStatusEligibleForRestore,
    monitorStartupRestore,
  } = await import(new URL("../dist/commands/restore.js", import.meta.url));
  assert(
    isPersistedStatusEligibleForRestore("stopped") === false &&
      isPersistedStatusEligibleForRestore("stopped", { startup: true }) ===
        true &&
      isPersistedStatusEligibleForRestore("blocked", { startup: true }) ===
        false &&
      isPersistedStatusEligibleForRestore("crash-loop", { startup: true }) ===
        false,
    "Expected startup restore mode to include stopped apps without reviving blocked/crash-loop apps or changing ordinary restore semantics.",
  );

  const restored = {
    name: "playbook",
    supervisorPid: 4100,
    startedAt: "2026-07-15T12:00:00.000Z",
  };
  const stoppedByDown = {
    name: "playbook",
    supervisorPid: 4100,
    childPid: undefined,
    wrapperPid: undefined,
    listenerPid: undefined,
    portOwnerPid: undefined,
    lastKnownStatus: "stopped",
    lastExitAt: "2026-07-15T12:00:05.000Z",
    blockedReason: undefined,
    crashLoopDetected: false,
  };
  assert(
    getStartupRestoreTerminalFailure([restored], {
      apps: { playbook: stoppedByDown },
    }) === undefined,
    "Expected normal lifeline down terminal state to let the startup wrapper succeed.",
  );
  assert(
    getStartupRestoreTerminalFailure([restored], {
      apps: {
        playbook: {
          ...stoppedByDown,
          childPid: 4200,
          lastKnownStatus: "running",
          lastExitAt: undefined,
        },
      },
    })?.includes("persisted status is running"),
    "Expected unexpected supervisor disappearance with stale running state to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure([restored], { apps: {} })?.includes(
      "runtime state is missing",
    ),
    "Expected missing restored-app state to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure([restored], {
      apps: {
        playbook: { ...stoppedByDown, supervisorPid: 4101 },
      },
    })?.includes("supervisor identity changed"),
    "Expected terminal state for a different supervisor identity to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure([restored], {
      apps: { playbook: { ...stoppedByDown, lastExitAt: undefined } },
    })?.includes("lacks a terminal timestamp"),
    "Expected stale stopped state without a terminal transition for this restore to fail closed.",
  );

  let staleAllDeadClock = 0;
  let staleAllDeadWaits = 0;
  const staleAllDeadFailure = await holdStartupRestoreWrapper([restored], {
    processAlive: async () => false,
    readRuntimeState: async () => ({
      apps: {
        playbook: {
          ...stoppedByDown,
          childPid: 4200,
          lastKnownStatus: "running",
          lastExitAt: undefined,
        },
      },
    }),
    now: () => staleAllDeadClock,
    wait: async (ms) => {
      staleAllDeadWaits += 1;
      staleAllDeadClock += ms;
    },
  });
  assert(
    staleAllDeadFailure?.includes("persisted status is running") &&
      staleAllDeadClock >= 2_000 &&
      staleAllDeadWaits >= 4,
    "An all-dead invocation with stale running state must poll through terminal grace and fail instead of returning clean success.",
  );

  const partialRestores = [
    {
      name: "first-success",
      supervisorPid: 5100,
      startedAt: "2026-07-15T12:00:00.000Z",
    },
    {
      name: "second-success-before-later-failure",
      supervisorPid: 5200,
      startedAt: "2026-07-15T12:00:01.000Z",
    },
  ];
  const partialAlive = new Set(partialRestores.map((app) => app.supervisorPid));
  const partialState = {
    apps: Object.fromEntries(
      partialRestores.map((app) => [
        app.name,
        {
          name: app.name,
          supervisorPid: app.supervisorPid,
          childPid: app.supervisorPid + 100,
          wrapperPid: app.supervisorPid + 200,
          listenerPid: app.supervisorPid + 100,
          portOwnerPid: app.supervisorPid + 100,
          lastKnownStatus: "running",
          blockedReason: undefined,
          crashLoopDetected: false,
        },
      ]),
    ),
  };
  const partialDownCalls = [];
  const partialCleanupFailure = await cleanupPartialStartupRestore(
    partialRestores,
    {
      downApp: async (name) => {
        partialDownCalls.push(name);
        const restoredApp = partialRestores.find((app) => app.name === name);
        partialAlive.delete(restoredApp.supervisorPid);
        partialState.apps[name] = {
          ...partialState.apps[name],
          supervisorPid: restoredApp.supervisorPid,
          childPid: undefined,
          wrapperPid: undefined,
          listenerPid: undefined,
          portOwnerPid: undefined,
          lastKnownStatus: "stopped",
          lastExitAt: "2026-07-15T12:00:10.000Z",
          blockedReason: undefined,
          crashLoopDetected: false,
        };
        return 0;
      },
      processAlive: async (pid) => partialAlive.has(pid),
      readRuntimeState: async () => partialState,
      stopSupervisor: async (pid) => {
        partialAlive.delete(pid);
      },
      wait: async () => undefined,
    },
  );
  assert(
    partialCleanupFailure === undefined &&
      JSON.stringify(partialDownCalls) ===
        JSON.stringify([
          "second-success-before-later-failure",
          "first-success",
        ]) &&
      partialAlive.size === 0 &&
      Object.values(partialState.apps).every(
        (app) =>
          app.lastKnownStatus === "stopped" &&
          app.childPid === undefined &&
          app.wrapperPid === undefined &&
          app.listenerPid === undefined &&
          app.portOwnerPid === undefined,
      ),
    "A later startup failure must clean and terminally verify every supervisor already started by the same multi-app invocation.",
  );

  const crashLoopRestore = {
    name: "crash-loop-cleanup",
    supervisorPid: 5300,
    startedAt: "2026-07-15T12:00:00.000Z",
  };
  const crashLoopAlive = new Set([crashLoopRestore.supervisorPid]);
  const crashLoopState = {
    apps: {
      "crash-loop-cleanup": {
        ...stoppedByDown,
        name: crashLoopRestore.name,
        supervisorPid: crashLoopRestore.supervisorPid,
        childPid: 5301,
        wrapperPid: 5302,
        listenerPid: 5301,
        portOwnerPid: 5301,
        lastKnownStatus: "crash-loop",
        lastExitAt: undefined,
        blockedReason: "restart threshold exceeded",
        crashLoopDetected: true,
      },
    },
  };
  const crashLoopDownCalls = [];
  const crashLoopStopCalls = [];
  let crashLoopWaits = 0;
  const crashLoopMonitorFailure = await monitorStartupRestore(
    [crashLoopRestore],
    {
      downApp: async (name) => {
        crashLoopDownCalls.push(name);
        crashLoopAlive.delete(crashLoopRestore.supervisorPid);
        crashLoopState.apps[name] = {
          ...crashLoopState.apps[name],
          childPid: undefined,
          wrapperPid: undefined,
          listenerPid: undefined,
          portOwnerPid: undefined,
          lastKnownStatus: "stopped",
          lastExitAt: "2026-07-15T12:00:10.000Z",
          blockedReason: undefined,
          crashLoopDetected: false,
        };
        return 0;
      },
      processAlive: async (pid) => crashLoopAlive.has(pid),
      readRuntimeState: async () => crashLoopState,
      stopSupervisor: async (pid) => {
        crashLoopStopCalls.push(pid);
        crashLoopAlive.delete(pid);
      },
      wait: async () => {
        crashLoopWaits += 1;
      },
    },
  );
  assert(
    crashLoopMonitorFailure?.includes("entered crash-loop") &&
      crashLoopMonitorFailure.includes("all supervisors started") &&
      !crashLoopMonitorFailure.includes("cleanup failed") &&
      JSON.stringify(crashLoopDownCalls) ===
        JSON.stringify(["crash-loop-cleanup"]) &&
      crashLoopStopCalls.length === 0 &&
      crashLoopWaits === 0 &&
      !crashLoopAlive.has(crashLoopRestore.supervisorPid) &&
      crashLoopState.apps["crash-loop-cleanup"].lastKnownStatus === "stopped" &&
      crashLoopState.apps["crash-loop-cleanup"].blockedReason === undefined &&
      crashLoopState.apps["crash-loop-cleanup"].crashLoopDetected === false,
    "Same-PID crash-loop cleanup must use graceful down, clear transient failure markers, verify the original PID dead, and avoid the terminal timeout path.",
  );

  const replacedRestore = {
    name: "replaced-during-hold",
    supervisorPid: 7100,
    startedAt: "2026-07-15T12:00:00.000Z",
  };
  const replacementState = {
    apps: {
      "replaced-during-hold": {
        ...stoppedByDown,
        name: "replaced-during-hold",
        supervisorPid: 7200,
        childPid: 7201,
        wrapperPid: 7202,
        listenerPid: 7201,
        portOwnerPid: 7201,
        lastKnownStatus: "running",
        lastExitAt: undefined,
      },
    },
  };
  const replacementAlive = new Set([7100, 7200]);
  const replacementDownCalls = [];
  const replacementStopCalls = [];
  const replacementMonitorFailure = await monitorStartupRestore(
    [replacedRestore],
    {
      downApp: async (name) => {
        replacementDownCalls.push(name);
        return 1;
      },
      processAlive: async (pid) => replacementAlive.has(pid),
      readRuntimeState: async () => replacementState,
      stopSupervisor: async (pid) => {
        replacementStopCalls.push(pid);
        replacementAlive.delete(pid);
      },
      wait: async () => undefined,
    },
  );
  assert(
    replacementMonitorFailure?.includes(
      "supervisor identity changed from 7100 to 7200 during startup hold",
    ) &&
      replacementMonitorFailure.includes("all supervisors started") &&
      !replacementMonitorFailure.includes("cleanup failed") &&
      replacementDownCalls.length === 0 &&
      JSON.stringify(replacementStopCalls) === JSON.stringify([7100]) &&
      !replacementAlive.has(7100) &&
      replacementAlive.has(7200) &&
      replacementState.apps["replaced-during-hold"].supervisorPid === 7200 &&
      replacementState.apps["replaced-during-hold"].lastKnownStatus ===
        "running",
    "Startup monitoring must report identity drift while successfully cleaning only the invocation-owned supervisor PID and preserving a newer replacement supervisor and its state.",
  );

  const earlyFailureRestores = [
    {
      name: "early-failure",
      supervisorPid: 6100,
      startedAt: "2026-07-15T12:00:00.000Z",
    },
    {
      name: "still-running",
      supervisorPid: 6200,
      startedAt: "2026-07-15T12:00:00.000Z",
    },
  ];
  const earlyFailureAlive = new Set([6200]);
  const earlyFailureState = {
    apps: {
      "early-failure": {
        name: "early-failure",
        supervisorPid: 6100,
        lastKnownStatus: "blocked",
        blockedReason: "fixture failure",
        crashLoopDetected: false,
      },
      "still-running": {
        name: "still-running",
        supervisorPid: 6200,
        childPid: 6201,
        wrapperPid: 6202,
        listenerPid: 6201,
        portOwnerPid: 6201,
        lastKnownStatus: "running",
        blockedReason: undefined,
        crashLoopDetected: false,
      },
    },
  };
  const earlyFailureDownCalls = [];
  const monitoredFailure = await monitorStartupRestore(earlyFailureRestores, {
    downApp: async (name) => {
      earlyFailureDownCalls.push(name);
      const restoredApp = earlyFailureRestores.find((app) => app.name === name);
      earlyFailureAlive.delete(restoredApp.supervisorPid);
      earlyFailureState.apps[name] = {
        ...earlyFailureState.apps[name],
        supervisorPid: restoredApp.supervisorPid,
        childPid: undefined,
        wrapperPid: undefined,
        listenerPid: undefined,
        portOwnerPid: undefined,
        lastKnownStatus: "stopped",
        lastExitAt: "2026-07-15T12:00:10.000Z",
        blockedReason: undefined,
        crashLoopDetected: false,
      };
      return 0;
    },
    processAlive: async (pid) => earlyFailureAlive.has(pid),
    readRuntimeState: async () => earlyFailureState,
    stopSupervisor: async (pid) => {
      earlyFailureAlive.delete(pid);
    },
    wait: async () => undefined,
  });
  assert(
    monitoredFailure?.includes("entered blocked") &&
      monitoredFailure.includes("all supervisors started") &&
      earlyFailureAlive.size === 0 &&
      earlyFailureDownCalls.length === 2 &&
      Object.values(earlyFailureState.apps).every(
        (app) =>
          app.lastKnownStatus === "stopped" &&
          app.supervisorPid !== undefined &&
          app.childPid === undefined &&
          app.wrapperPid === undefined,
      ),
    "An early failed supervisor must end the hold, clean a second still-running supervisor, and verify the entire invocation stopped.",
  );
}

async function verifyContractSurfaceWiring() {
  const startupCommandSource = await readFile(
    new URL("../src/commands/startup.ts", import.meta.url),
    "utf8",
  );
  const startupCoreSource = await readFile(
    new URL("../src/core/startup-contract.ts", import.meta.url),
    "utf8",
  );
  const startupBackendSource = await readFile(
    new URL("../src/core/startup-backend.ts", import.meta.url),
    "utf8",
  );
  const restoreCommandSource = await readFile(
    new URL("../src/commands/restore.ts", import.meta.url),
    "utf8",
  );

  assert(
    startupCommandSource.includes("--dry-run"),
    "Expected startup command to expose --dry-run planning support.",
  );

  assert(
    startupCoreSource.includes("resolveStartupBackend"),
    "Expected startup core to route planning/status through startup backend resolution.",
  );

  assert(
    startupCommandSource.includes("backend.install") &&
      startupCommandSource.includes("backend.uninstall") &&
      startupCommandSource.includes("backendResult.ok === false"),
    "Expected startup command to wire enable/disable through backend calls and fail closed on rejected mutations.",
  );

  assert(
    startupBackendSource.includes('status: "unsupported"'),
    "Expected default startup backend to report unsupported status cleanly.",
  );

  assert(
    startupCoreSource.includes('restoreEntrypoint: "lifeline restore"'),
    "Expected startup core to keep restore entrypoint as lifeline restore.",
  );

  assert(
    restoreCommandSource.includes("holdStartupRestoreWrapper") &&
      restoreCommandSource.includes("monitorStartupRestore") &&
      restoreCommandSource.includes("cleanupPartialStartupRestore") &&
      restoreCommandSource.includes("startDetachedExecutable") &&
      restoreCommandSource.includes("restoredSupervisorPids"),
    "Expected startup restore mode to launch the exact supervisor directly and keep the scheduler action alive while it runs.",
  );
}

async function verifySeamInstallDisableStatusAndDryRun() {
  await ensureBuiltCli();

  const tempDir = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "lifeline-wave2-startup-")),
  );
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const startupContractModule = await import(
      new URL("../dist/core/startup-contract.js", import.meta.url)
    );
    const {
      planStartupAction,
      createStartupMutationRequest,
      setStartupIntent,
      getStartupStatus,
    } = startupContractModule;

    const statePath = path.join(tempDir, ".lifeline", "startup.json");
    const fakeBackendState = {
      installed: false,
      installRequests: [],
      uninstallRequests: [],
    };

    const fakeBackend = {
      id: "deterministic-fake-backend",
      capabilities: ["inspect", "install", "uninstall"],
      inspect: async () => ({
        supported: true,
        status: fakeBackendState.installed ? "installed" : "not-installed",
        mechanism: "deterministic-fake-backend",
        detail: fakeBackendState.installed
          ? "Fake backend reports startup registration installed."
          : "Fake backend reports startup registration not installed.",
      }),
      install: async (request) => {
        fakeBackendState.installRequests.push(request);
        if (request.dryRun) {
          return {
            status: "not-installed",
            detail: "Dry-run: fake backend would install startup registration.",
          };
        }

        fakeBackendState.installed = true;
        return {
          status: "installed",
          detail: "Fake backend installed startup registration.",
        };
      },
      uninstall: async (request) => {
        fakeBackendState.uninstallRequests.push(request);
        if (request.dryRun) {
          return {
            status: fakeBackendState.installed ? "installed" : "not-installed",
            detail: "Dry-run: fake backend would remove startup registration.",
          };
        }

        fakeBackendState.installed = false;
        return {
          status: "not-installed",
          detail: "Fake backend removed startup registration.",
        };
      },
    };

    const dryRunEnablePlan = await planStartupAction("enable", fakeBackend);
    assert(
      dryRunEnablePlan.backendStatus === "not-installed",
      "Expected enable dry-run plan to stay not-installed.",
    );
    assert(
      fakeBackendState.installRequests.length === 1 &&
        fakeBackendState.installRequests[0].dryRun === true,
      "Expected enable plan to call backend install through dry-run seam request.",
    );
    await access(statePath).then(
      () => {
        throw new Error(
          "Dry-run planning must not create .lifeline/startup.json.",
        );
      },
      () => undefined,
    );

    const enableResult = await fakeBackend.install(
      createStartupMutationRequest(),
    );
    await setStartupIntent("enabled", enableResult.status);
    const statusAfterEnable = await getStartupStatus(fakeBackend);
    assert(
      statusAfterEnable.enabled === true,
      "Expected startup status to report enabled after install mutation.",
    );
    assert(
      statusAfterEnable.detail.includes("installed"),
      `Expected enabled startup status detail to include installed signal, got: ${statusAfterEnable.detail}`,
    );

    const dryRunDisablePlan = await planStartupAction("disable", fakeBackend);
    assert(
      dryRunDisablePlan.backendStatus === "installed",
      `Expected disable dry-run plan to reflect installed backend state, got ${dryRunDisablePlan.backendStatus}.`,
    );
    assert(
      fakeBackendState.uninstallRequests.length === 1 &&
        fakeBackendState.uninstallRequests[0].dryRun === true,
      "Expected disable plan to call backend uninstall through dry-run seam request.",
    );

    const disableResult = await fakeBackend.uninstall(
      createStartupMutationRequest(),
    );
    await setStartupIntent("disabled", disableResult.status);
    const statusAfterDisable = await getStartupStatus(fakeBackend);
    assert(
      statusAfterDisable.enabled === false,
      "Expected startup status to report disabled after uninstall mutation.",
    );
    assert(
      statusAfterDisable.detail.includes("not installed"),
      `Expected disabled startup status detail to include not-installed signal, got: ${statusAfterDisable.detail}`,
    );
  } finally {
    process.chdir(previousCwd);
  }
}

async function verifyBackendResolutionCoverageAndFallback() {
  await ensureBuiltCli();
  const startupBackendModule = await import(
    new URL("../dist/core/startup-backend.js", import.meta.url)
  );
  const { resolveStartupBackend, DEFAULT_STARTUP_BACKEND_REGISTRY } =
    startupBackendModule;

  const resolvedPlatforms = Object.keys(
    DEFAULT_STARTUP_BACKEND_REGISTRY.byPlatform,
  ).sort();
  const expectedPlatforms = [
    "aix",
    "darwin",
    "freebsd",
    "linux",
    "netbsd",
    "openbsd",
    "win32",
  ];
  assert(
    JSON.stringify(resolvedPlatforms) === JSON.stringify(expectedPlatforms),
    `Expected startup backend registry coverage ${expectedPlatforms.join(", ")}, got ${resolvedPlatforms.join(", ")}.`,
  );

  const darwinBackend = resolveStartupBackend({ platform: "darwin" });
  assert(
    darwinBackend.id === "launchd-agent",
    `Expected darwin backend to resolve to launchd-agent, got ${darwinBackend.id}.`,
  );

  const linuxBackend = resolveStartupBackend({ platform: "linux" });
  assert(
    linuxBackend.id === "systemd-user",
    `Expected linux backend to resolve to systemd-user, got ${linuxBackend.id}.`,
  );

  const win32Backend = resolveStartupBackend({ platform: "win32" });
  assert(
    win32Backend.id === "windows-task-scheduler",
    `Expected win32 backend to resolve to windows-task-scheduler, got ${win32Backend.id}.`,
  );

  const freebsdBackend = resolveStartupBackend({ platform: "freebsd" });
  assert(
    freebsdBackend.id === "freebsd-rc.d",
    `Expected freebsd backend to resolve to freebsd-rc.d, got ${freebsdBackend.id}.`,
  );

  const openbsdBackend = resolveStartupBackend({ platform: "openbsd" });
  assert(
    openbsdBackend.id === "openbsd-rcctl",
    `Expected openbsd backend to resolve to openbsd-rcctl, got ${openbsdBackend.id}.`,
  );

  const netbsdBackend = resolveStartupBackend({ platform: "netbsd" });
  assert(
    netbsdBackend.id === "netbsd-rc.d",
    `Expected netbsd backend to resolve to netbsd-rc.d, got ${netbsdBackend.id}.`,
  );

  const aixBackend = resolveStartupBackend({ platform: "aix" });
  assert(
    aixBackend.id === "aix-inittab",
    `Expected aix backend to resolve to aix-inittab, got ${aixBackend.id}.`,
  );
  const aixInspection = await aixBackend.inspect();
  assert(
    ["installed", "not-installed", "unsupported"].includes(
      aixInspection.status,
    ),
    `Expected aix inspection status installed|not-installed|unsupported, got ${aixInspection.status}.`,
  );

  const unknownBackend = resolveStartupBackend({ platform: "sunos" });
  const fallbackInspection = await unknownBackend.inspect();
  assert(
    fallbackInspection.supported === false,
    "Expected unsupported fallback backend to report supported=false.",
  );
  assert(
    fallbackInspection.mechanism === "contract-only",
    `Expected contract-only mechanism, got ${fallbackInspection.mechanism}.`,
  );
  assert(
    fallbackInspection.detail.includes(
      "No startup installer backend is available on sunos yet.",
    ),
    `Expected unsupported inspection detail to include platform name, got: ${fallbackInspection.detail}`,
  );
}

async function verifyFreebsdRcDBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendFreebsdModule = await import(
    new URL("../dist/core/startup-backends/freebsd-rcd.js", import.meta.url)
  );
  const { createFreebsdRcDBackend } = startupBackendFreebsdModule;

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-freebsd-backend-"),
  );
  const rcDDirectory = path.join(tempRoot, "usr", "local", "etc", "rc.d");
  const rcConfDirectory = path.join(tempRoot, "etc", "rc.conf.d");

  const backend = createFreebsdRcDBackend({ rcDDirectory, rcConfDirectory });

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected FreeBSD dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("would write") &&
      dryRunInstall.detail.includes("lifeline_restore"),
    `Expected FreeBSD dry-run install detail to describe rc.d intent, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected FreeBSD install status installed, got ${installResult.status}.`,
  );

  const scriptPath = path.join(rcDDirectory, "lifeline_restore");
  const rcConfPath = path.join(rcConfDirectory, "lifeline_restore");
  const scriptContents = await readFile(scriptPath, "utf8");
  const rcConfContents = await readFile(rcConfPath, "utf8");
  assert(
    scriptContents.includes("lifeline restore"),
    `Expected installed rc.d script to keep canonical restore entrypoint.\n${scriptContents}`,
  );
  assert(
    rcConfContents.includes('lifeline_restore_enable="YES"'),
    `Expected installed rc.conf entry to enable startup.\n${rcConfContents}`,
  );

  const inspectResult = await backend.inspect();
  assert(
    inspectResult.status === "installed",
    `Expected FreeBSD inspect status installed after install, got ${inspectResult.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes("would remove") ||
      dryRunUninstall.detail.includes("is not present"),
    `Expected FreeBSD dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected FreeBSD uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const inspectAfterUninstall = await backend.inspect();
  assert(
    inspectAfterUninstall.status === "not-installed",
    `Expected FreeBSD inspect status not-installed after uninstall, got ${inspectAfterUninstall.status}.`,
  );
}

async function verifyWindowsTaskSchedulerBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } =
    await import("node:fs/promises");
  const { createWindowsTaskSchedulerBackend } = await import(
    new URL(
      "../dist/core/startup-backends/windows-task-scheduler.js",
      import.meta.url,
    )
  );

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-windows-backend-"),
  );
  const runtimeRoot = path.join(tempRoot, "runtime-home");
  const sourceDirectory = path.join(tempRoot, "worktree-dist");
  const sourceCli = path.join(sourceDirectory, "cli.js");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourceCli, "console.log('fixture');\n", "utf8");
  await writeFile(
    path.join(sourceDirectory, "support.js"),
    "export const fixture = true;\n",
    "utf8",
  );

  let registeredXml = "";
  const invocations = [];
  const runner = async (args) => {
    invocations.push([...args]);
    if (args[0] === "/Query") {
      return registeredXml
        ? { code: 0, stdout: registeredXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      const xmlPath = args[args.indexOf("/XML") + 1];
      registeredXml = await readFile(xmlPath, "utf8");
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (args[0] === "/Delete") {
      registeredXml = "";
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(`Unexpected schtasks fixture call: ${args.join(" ")}`);
  };

  const options = {
    rootDirectory: runtimeRoot,
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    cliEntrypoint: sourceCli,
    identity: {
      account: "ATLAS\\operator",
      sid: "S-1-5-21-111-222-333-1001",
    },
  };
  const backend = createWindowsTaskSchedulerBackend(runner, options);
  const request = {
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  };

  const unavailableBackend = createWindowsTaskSchedulerBackend(
    async () => ({
      code: -1,
      stdout: "",
      stderr: "fixture scheduler executable unavailable",
    }),
    {
      rootDirectory: sourceDirectory,
      cliEntrypoint: path.join(sourceDirectory, "missing-cli.js"),
    },
  );
  const unavailableInspection = await unavailableBackend.inspect();
  const unavailableInstall = await unavailableBackend.install(request);
  assert(
    unavailableInspection.status === "unsupported" &&
      unavailableInstall.status === "unsupported" &&
      unavailableInstall.ok === false,
    "An unavailable scheduler runner must report unsupported before resolving whoami or launcher paths.",
  );

  const rootEqualsSource = await createWindowsTaskSchedulerBackend(runner, {
    ...options,
    rootDirectory: sourceDirectory,
  }).install(request);
  const rootUnderSource = await createWindowsTaskSchedulerBackend(runner, {
    ...options,
    rootDirectory: path.join(sourceDirectory, "nested-runtime"),
  }).install(request);
  assert(
    rootEqualsSource.ok === false &&
      rootUnderSource.ok === false &&
      rootEqualsSource.detail.includes("must not be the launcher source") &&
      rootUnderSource.detail.includes("must not be the launcher source") &&
      !(await access(path.join(sourceDirectory, ".lifeline"))
        .then(() => true)
        .catch(() => false)) &&
      !(await access(path.join(sourceDirectory, "nested-runtime"))
        .then(() => true)
        .catch(() => false)),
    "Runtime roots equal to or beneath the CLI dist source must fail before hashing or recursive launcher copy.",
  );

  const dryRun = await backend.install({ ...request, dryRun: true });
  assert(
    dryRun.status === "not-installed" && dryRun.ok !== false,
    `Expected absent Windows dry-run to be actionable, got ${JSON.stringify(dryRun)}.`,
  );
  const runtimeStateExists = await access(path.join(runtimeRoot, ".lifeline"))
    .then(() => true)
    .catch(() => false);
  assert(
    runtimeStateExists === false,
    "Windows startup dry-run must not create launcher or state paths.",
  );

  const hashDriftSourceDirectory = path.join(tempRoot, "hash-drift-dist");
  const hashDriftRuntimeRoot = path.join(tempRoot, "hash-drift-runtime");
  await mkdir(hashDriftSourceDirectory, { recursive: true });
  await writeFile(
    path.join(hashDriftSourceDirectory, "cli.js"),
    "console.log('hash drift fixture');\n",
    "utf8",
  );
  const hashDriftSupportPath = path.join(
    hashDriftSourceDirectory,
    "support.js",
  );
  await writeFile(
    hashDriftSupportPath,
    "export const version = 'planned';\n",
    "utf8",
  );
  let hashDriftCreateCount = 0;
  let hashDriftHookCount = 0;
  const hashDriftBackend = createWindowsTaskSchedulerBackend(
    async (args) => {
      if (args[0] === "/Query") {
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
        };
      }
      if (args[0] === "/Create") {
        hashDriftCreateCount += 1;
      }
      throw new Error(
        `Unexpected hash-drift scheduler call: ${args.join(" ")}`,
      );
    },
    {
      ...options,
      rootDirectory: hashDriftRuntimeRoot,
      cliEntrypoint: path.join(hashDriftSourceDirectory, "cli.js"),
      beforeLauncherSnapshotCopy: async () => {
        hashDriftHookCount += 1;
        await writeFile(
          hashDriftSupportPath,
          "export const version = 'mutated-after-plan';\n",
          "utf8",
        );
      },
    },
  );
  let hashDriftError = "";
  try {
    await hashDriftBackend.install(request);
  } catch (error) {
    hashDriftError = error instanceof Error ? error.message : String(error);
  }
  const hashDriftStartupDirectory = path.join(
    hashDriftRuntimeRoot,
    ".lifeline",
    "startup",
    "windows",
  );
  const hashDriftEntries = await readdir(hashDriftStartupDirectory);
  assert(
    hashDriftHookCount === 1 &&
      hashDriftCreateCount === 0 &&
      hashDriftError.includes("does not match planned content hash") &&
      !hashDriftEntries.some((name) => /^launcher-[0-9a-f]{16}$/.test(name)),
    "Source mutation after launcher planning must fail the staged payload hash gate before metadata, canonical publication, or scheduler creation.",
  );

  const concurrentRuntimeRoot = path.join(tempRoot, "concurrent-runtime-home");
  const concurrentOptions = {
    ...options,
    rootDirectory: concurrentRuntimeRoot,
  };
  let concurrentRegisteredXml = "";
  const runConcurrentEnableRound = async () => {
    let initialQueryCount = 0;
    let releaseInitialQueries;
    const bothInitialQueries = new Promise((resolve) => {
      releaseInitialQueries = resolve;
    });
    let createInvocationCount = 0;
    let releaseCreateInvocations;
    const bothCreateInvocations = new Promise((resolve) => {
      releaseCreateInvocations = resolve;
    });
    const concurrentInvocations = [];
    const createDefinitionReads = [];
    const concurrentRunner = async (args) => {
      concurrentInvocations.push([...args]);
      if (args[0] === "/Query") {
        if (!concurrentRegisteredXml && initialQueryCount < 2) {
          initialQueryCount += 1;
          if (initialQueryCount === 2) {
            releaseInitialQueries();
          }
          await bothInitialQueries;
          return {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
        }
        return concurrentRegisteredXml
          ? { code: 0, stdout: concurrentRegisteredXml, stderr: "" }
          : {
              code: 1,
              stdout: "",
              stderr: "ERROR: The system cannot find the file specified.",
            };
      }
      if (args[0] === "/Create") {
        createInvocationCount += 1;
        if (createInvocationCount === 2) {
          releaseCreateInvocations();
        }
        await bothCreateInvocations;
        const xmlPath = args[args.indexOf("/XML") + 1];
        const requestedXml = await readFile(xmlPath, "utf8");
        createDefinitionReads.push({ xmlPath, requestedXml });
        if (concurrentRegisteredXml) {
          return {
            code: 1,
            stdout: "",
            stderr:
              "ERROR: Cannot create a file when that file already exists.",
          };
        }
        concurrentRegisteredXml = requestedXml;
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (args[0] === "/Delete") {
        throw new Error(
          "Concurrent enable must never delete the winning task.",
        );
      }
      throw new Error(
        `Unexpected concurrent schtasks fixture call: ${args.join(" ")}`,
      );
    };
    const concurrentBackendA = createWindowsTaskSchedulerBackend(
      concurrentRunner,
      concurrentOptions,
    );
    const concurrentBackendB = createWindowsTaskSchedulerBackend(
      concurrentRunner,
      concurrentOptions,
    );
    const results = await Promise.all([
      concurrentBackendA.install(request),
      concurrentBackendB.install(request),
    ]);
    return {
      results,
      concurrentInvocations,
      concurrentBackendA,
      createDefinitionReads,
    };
  };

  const coldConcurrentRound = await runConcurrentEnableRound();
  const concurrentStartupDirectory = path.join(
    concurrentRuntimeRoot,
    ".lifeline",
    "startup",
    "windows",
  );
  const coldStartupEntries = await readdir(concurrentStartupDirectory);
  const concurrentLauncherName = coldStartupEntries.find((name) =>
    /^launcher-[0-9a-f]{16}$/.test(name),
  );
  assert(
    coldConcurrentRound.results.every(
      (result) => result.status === "installed" && result.ok !== false,
    ) &&
      coldConcurrentRound.results.some((result) =>
        result.detail.includes("enable converged"),
      ) &&
      concurrentLauncherName &&
      coldStartupEntries.filter((name) => /^launcher-[0-9a-f]{16}$/.test(name))
        .length === 1 &&
      !coldStartupEntries.some((name) =>
        /\.(?:staging|quarantine|materialize\.lock)-?/.test(name),
      ) &&
      (await coldConcurrentRound.concurrentBackendA.inspect()).status ===
        "installed" &&
      coldConcurrentRound.createDefinitionReads.length === 2 &&
      new Set(
        coldConcurrentRound.createDefinitionReads.map(({ xmlPath }) => xmlPath),
      ).size === 2 &&
      coldConcurrentRound.createDefinitionReads.every(
        ({ requestedXml }) =>
          requestedXml.startsWith("<Task") &&
          requestedXml.endsWith("</Task>\n"),
      ) &&
      (
        await Promise.all(
          coldConcurrentRound.createDefinitionReads.map(({ xmlPath }) =>
            access(xmlPath)
              .then(() => true)
              .catch(() => false),
          ),
        )
      ).every((exists) => !exists) &&
      !coldConcurrentRound.concurrentInvocations.some(
        ([command]) => command === "/Delete",
      ),
    "Two cold concurrent enables must publish one verified launcher and converge through distinct complete invocation-owned task XML files without deletion.",
  );

  const concurrentLauncherDirectory = path.join(
    concurrentStartupDirectory,
    concurrentLauncherName,
  );
  const concurrentSupportPath = path.join(
    concurrentLauncherDirectory,
    "support.js",
  );
  const concurrentMetadataPath = path.join(
    concurrentLauncherDirectory,
    "launcher.json",
  );
  const concurrentMetadata = await readFile(concurrentMetadataPath, "utf8");
  await writeFile(
    concurrentSupportPath,
    "export const fixture = 'corrupt';\n",
    "utf8",
  );
  concurrentRegisteredXml = "";
  const concurrentRepairRound = await runConcurrentEnableRound();
  const repairStartupEntries = await readdir(concurrentStartupDirectory);
  assert(
    concurrentRepairRound.results.every(
      (result) => result.status === "installed" && result.ok !== false,
    ) &&
      (await readFile(concurrentSupportPath, "utf8")) ===
        (await readFile(path.join(sourceDirectory, "support.js"), "utf8")) &&
      (await readFile(concurrentMetadataPath, "utf8")) === concurrentMetadata &&
      !repairStartupEntries.some((name) =>
        /\.(?:staging|quarantine|materialize\.lock)-?/.test(name),
      ) &&
      !concurrentRepairRound.concurrentInvocations.some(
        ([command]) => command === "/Delete",
      ),
    "Concurrent repair must quarantine the invalid final snapshot, atomically republish exact bytes, and let the loser accept the verified winner.",
  );

  await writeFile(
    concurrentSupportPath,
    "export const fixture = 'crash-residue';\n",
    "utf8",
  );
  const abandonedLeaseDirectory = `${concurrentLauncherDirectory}.materialize.lock`;
  await mkdir(abandonedLeaseDirectory);
  await writeFile(
    path.join(abandonedLeaseDirectory, "owner.json"),
    `${JSON.stringify(
      {
        version: 1,
        ownerId: "dead-publisher",
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const abandonedLeaseRecovery = await createWindowsTaskSchedulerBackend(
    async (args) => {
      if (args[0] === "/Query") {
        return { code: 0, stdout: concurrentRegisteredXml, stderr: "" };
      }
      throw new Error(
        `Unexpected abandoned-lease fixture call: ${args.join(" ")}`,
      );
    },
    concurrentOptions,
  ).install(request);
  const recoveryStartupEntries = await readdir(concurrentStartupDirectory);
  assert(
    abandonedLeaseRecovery.status === "installed" &&
      abandonedLeaseRecovery.ok !== false &&
      (await readFile(concurrentSupportPath, "utf8")) ===
        (await readFile(path.join(sourceDirectory, "support.js"), "utf8")) &&
      !recoveryStartupEntries.some((name) =>
        /\.(?:staging|quarantine|materialize\.lock)-?/.test(name),
      ),
    "A dead publisher lease plus invalid canonical snapshot must be reclaimed and repaired without accepting partial bytes or leaving owned staging/quarantine residue.",
  );

  const installResult = await backend.install(request);
  assert(
    installResult.status === "installed" && installResult.ok !== false,
    `Expected Windows startup install to succeed, got ${JSON.stringify(installResult)}.`,
  );
  assert(
    registeredXml.includes("<LogonTrigger>") &&
      registeredXml.includes("S-1-5-21-111-222-333-1001") &&
      registeredXml.includes("<LogonType>InteractiveToken</LogonType>") &&
      registeredXml.includes("<RunLevel>LeastPrivilege</RunLevel>") &&
      registeredXml.includes(
        "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      ),
    `Expected exact current-user/least-privilege logon definition.\n${registeredXml}`,
  );
  assert(
    registeredXml.includes("--root") &&
      registeredXml.includes("restore --startup") &&
      registeredXml.includes(runtimeRoot) &&
      !registeredXml.includes(sourceDirectory),
    `Expected scheduler action to use an explicit root and stable runtime launcher, not source worktree.\n${registeredXml}`,
  );
  const createCallsAfterInstall = invocations.filter(
    ([command]) => command === "/Create",
  );
  assert(
    createCallsAfterInstall.length === 1 &&
      !createCallsAfterInstall[0].includes("/F"),
    "First Windows registration must create without force-overwriting a same-name task.",
  );

  const firstDefinition = registeredXml;
  const reenableResult = await backend.install(request);
  assert(
    reenableResult.status === "installed" &&
      invocations.filter(([command]) => command === "/Create").length === 1 &&
      registeredXml === firstDefinition,
    "Repeated Windows startup enable must preserve the exact definition without creating a duplicate.",
  );

  const schedulerCanonicalDefinition = firstDefinition
    .replace("      <Enabled>true</Enabled>\n", "")
    .replace("      <RunLevel>LeastPrivilege</RunLevel>\n", "");
  registeredXml = schedulerCanonicalDefinition;
  const createsBeforeCanonicalizedReadback = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const canonicalizedInspection = await backend.inspect();
  const canonicalizedReenable = await backend.install(request);
  assert(
    canonicalizedInspection.status === "installed" &&
      canonicalizedReenable.status === "installed" &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeCanonicalizedReadback &&
      registeredXml === schedulerCanonicalDefinition,
    "Scheduler omission of declared true/least-privilege defaults must remain exact acceptance without allowing unknown trigger/principal structure.",
  );
  registeredXml = firstDefinition;

  const startupDirectory = path.join(
    runtimeRoot,
    ".lifeline",
    "startup",
    "windows",
  );
  const launcherDirectoryName = (await readdir(startupDirectory)).find((name) =>
    name.startsWith("launcher-"),
  );
  assert(
    launcherDirectoryName,
    "Expected startup install to create one content-addressed launcher directory.",
  );
  const launcherDirectory = path.join(startupDirectory, launcherDirectoryName);
  const launcherMetadataPath = path.join(launcherDirectory, "launcher.json");
  const launcherSupportPath = path.join(launcherDirectory, "support.js");
  const unexpectedLauncherPath = path.join(launcherDirectory, "unexpected.js");
  const metadataBeforeCorruption = await readFile(launcherMetadataPath, "utf8");
  await writeFile(
    launcherSupportPath,
    "export const fixture = false;\n",
    "utf8",
  );
  await writeFile(
    unexpectedLauncherPath,
    "throw new Error('foreign');\n",
    "utf8",
  );
  assert(
    (await readFile(launcherMetadataPath, "utf8")) === metadataBeforeCorruption,
    "Launcher corruption fixture must retain the trusted-looking metadata.",
  );
  const createsBeforeLauncherRepair = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const repairResult = await backend.install(request);
  const unexpectedFileExists = await access(unexpectedLauncherPath)
    .then(() => true)
    .catch(() => false);
  assert(
    repairResult.status === "installed" &&
      (await readFile(launcherSupportPath, "utf8")) ===
        (await readFile(path.join(sourceDirectory, "support.js"), "utf8")) &&
      unexpectedFileExists === false &&
      (await readFile(launcherMetadataPath, "utf8")) ===
        metadataBeforeCorruption &&
      registeredXml === firstDefinition &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeLauncherRepair,
    "Repeated enable must byte-verify and repair a corrupted launcher snapshot without changing the exact task definition.",
  );

  registeredXml = registeredXml.replace(
    "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
  );
  const reconcileResult = await backend.install(request);
  const reconcileCreate = invocations
    .filter(([command]) => command === "/Create")
    .at(-1);
  assert(
    reconcileResult.status === "installed" &&
      reconcileCreate?.includes("/F") &&
      registeredXml === firstDefinition,
    "Lifeline-owned same-root drift must reconcile through one forced update after ownership validation.",
  );

  registeredXml = firstDefinition
    .replace(
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>",
    )
    .replace(
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>",
    )
    .replace(
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
    );
  const settingsDriftInspection = await backend.inspect();
  const settingsDriftRepair = await backend.install(request);
  assert(
    settingsDriftInspection.status === "not-installed" &&
      settingsDriftRepair.status === "installed" &&
      invocations
        .filter(([command]) => command === "/Create")
        .at(-1)
        ?.includes("/F") &&
      registeredXml === firstDefinition,
    "Reliability-critical Windows settings drift must fail exact inspection and repair to the complete required contract.",
  );

  registeredXml = firstDefinition.replace(
    "  </Settings>",
    `    <AllowStartOnDemand>false</AllowStartOnDemand>
  </Settings>`,
  );
  const extraSettingInspection = await backend.inspect();
  const extraSettingRepair = await backend.install(request);
  assert(
    extraSettingInspection.status === "not-installed" &&
      extraSettingRepair.status === "installed" &&
      invocations
        .filter(([command]) => command === "/Create")
        .at(-1)
        ?.includes("/F") &&
      registeredXml === firstDefinition,
    "An unrecognized behavioral setting must prevent installed acceptance and reconcile to the exact v4 Settings structure.",
  );

  registeredXml = firstDefinition.replace(
    "  </Actions>",
    `    <Exec>
      <Command>C:\\Windows\\System32\\cmd.exe</Command>
      <Arguments>/c exit 0</Arguments>
      <WorkingDirectory>${runtimeRoot}</WorkingDirectory>
    </Exec>
  </Actions>`,
  );
  const createsBeforeExtraAction = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeExtraAction = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const extraActionInstall = await backend.install(request);
  const extraActionUninstall = await backend.uninstall(request);
  assert(
    extraActionInstall.ok === false &&
      extraActionUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeExtraAction &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeExtraAction &&
      registeredXml.includes("cmd.exe"),
    "A same-root task with a second action must be rejected without overwrite or removal.",
  );

  registeredXml = firstDefinition.replace(
    "  </Triggers>",
    `    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>`,
  );
  const createsBeforeExtraTrigger = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeExtraTrigger = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const extraTriggerInspection = await backend.inspect();
  const extraTriggerInstall = await backend.install(request);
  const extraTriggerUninstall = await backend.uninstall(request);
  assert(
    extraTriggerInspection.status === "not-installed" &&
      extraTriggerInstall.ok === false &&
      extraTriggerUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeExtraTrigger &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeExtraTrigger &&
      registeredXml.includes("<BootTrigger>"),
    "A current-v4 task with an additional trigger must fail status acceptance, enable, and disable without mutation.",
  );

  const v3Definition = firstDefinition.replace(
    "Windows startup v4.",
    "Windows startup v3.",
  );
  registeredXml = v3Definition;
  const createsBeforeV3DryRun = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const v3DryRun = await backend.install({ ...request, dryRun: true });
  assert(
    v3DryRun.status === "not-installed" &&
      v3DryRun.ok !== false &&
      v3DryRun.detail.includes("would reconcile") &&
      v3DryRun.detail.includes("exact current-v4 definition") &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeV3DryRun &&
      registeredXml === v3Definition,
    "Recognized owned drift must produce an actionable, non-mutating enable dry-run plan that predicts the real v4 upgrade.",
  );
  const v3UpgradeResult = await backend.install(request);
  assert(
    v3UpgradeResult.status === "installed" && registeredXml === firstDefinition,
    "A recognized same-current-user v3 task must remain upgradeable to the exact v4 definition.",
  );

  const v2Definition = firstDefinition
    .replace("Windows startup v4.", "Windows startup v2.")
    .replace(" restore --startup</Arguments>", " restore</Arguments>");
  registeredXml = v2Definition.replace(
    "  </Principals>",
    `    <Principal id="Foreign">
      <UserId>S-1-5-21-111-222-333-1001</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>`,
  );
  const createsBeforeExtraPrincipal = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeExtraPrincipal = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const extraPrincipalInspection = await backend.inspect();
  const extraPrincipalInstall = await backend.install(request);
  const extraPrincipalUninstall = await backend.uninstall(request);
  assert(
    extraPrincipalInspection.status === "not-installed" &&
      extraPrincipalInstall.ok === false &&
      extraPrincipalUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeExtraPrincipal &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeExtraPrincipal &&
      registeredXml.includes('id="Foreign"'),
    "A legacy owned-looking task with an additional principal must classify conflict for status, enable, and disable.",
  );

  registeredXml = v2Definition;
  const v2UpgradeResult = await backend.install(request);
  assert(
    v2UpgradeResult.status === "installed" &&
      invocations
        .filter(([command]) => command === "/Create")
        .at(-1)
        ?.includes("/F") &&
      registeredXml === firstDefinition,
    "A Lifeline v2 task with the same root and recognized stable action must upgrade to v4.",
  );

  const foreignReplacementDefinition = firstDefinition.replace(
    "<Author>Lifeline</Author>",
    "<Author>Foreign</Author>",
  );
  let foreignBeforeForceQueryCount = 0;
  let foreignBeforeForceCreateCount = 0;
  const foreignBeforeForceRunner = async (args) => {
    if (args[0] === "/Query") {
      foreignBeforeForceQueryCount += 1;
      return {
        code: 0,
        stdout:
          foreignBeforeForceQueryCount === 1
            ? v2Definition
            : foreignReplacementDefinition,
        stderr: "",
      };
    }
    if (args[0] === "/Create") {
      foreignBeforeForceCreateCount += 1;
      throw new Error("Foreign replacement must not be overwritten.");
    }
    throw new Error(
      `Unexpected pre-force foreign fixture call: ${args.join(" ")}`,
    );
  };
  const foreignBeforeForceBackend = createWindowsTaskSchedulerBackend(
    foreignBeforeForceRunner,
    options,
  );
  const foreignBeforeForceResult =
    await foreignBeforeForceBackend.install(request);
  assert(
    foreignBeforeForceResult.ok === false &&
      foreignBeforeForceResult.status === "installed" &&
      foreignBeforeForceResult.detail.includes(
        "changed after owned-drift inspection",
      ) &&
      foreignBeforeForceCreateCount === 0 &&
      foreignBeforeForceQueryCount === 2,
    "An owned-drift upgrade must re-read the exact inspected XML immediately before /Create /F and preserve a foreign replacement without mutation.",
  );

  let exactBeforeForceQueryCount = 0;
  let exactBeforeForceCreateCount = 0;
  const exactBeforeForceRunner = async (args) => {
    if (args[0] === "/Query") {
      exactBeforeForceQueryCount += 1;
      return {
        code: 0,
        stdout:
          exactBeforeForceQueryCount === 1 ? v2Definition : firstDefinition,
        stderr: "",
      };
    }
    if (args[0] === "/Create") {
      exactBeforeForceCreateCount += 1;
      throw new Error("Exact concurrent winner must not be overwritten.");
    }
    throw new Error(
      `Unexpected pre-force exact fixture call: ${args.join(" ")}`,
    );
  };
  const exactBeforeForceBackend = createWindowsTaskSchedulerBackend(
    exactBeforeForceRunner,
    options,
  );
  const exactBeforeForceResult = await exactBeforeForceBackend.install(request);
  assert(
    exactBeforeForceResult.ok !== false &&
      exactBeforeForceResult.status === "installed" &&
      exactBeforeForceResult.detail.includes(
        "converged without overwriting the concurrent winner",
      ) &&
      exactBeforeForceCreateCount === 0 &&
      exactBeforeForceQueryCount === 2,
    "An owned-drift upgrade that reads an exact current-v4 winner immediately before /Create /F must converge without forced replacement.",
  );

  registeredXml = v2Definition.replaceAll(
    "S-1-5-21-111-222-333-1001",
    "ATLAS\\operator",
  );
  const canonicalizedIdentityUpgrade = await backend.install(request);
  assert(
    canonicalizedIdentityUpgrade.status === "installed" &&
      registeredXml === firstDefinition,
    "A same-current-user v2 task must remain upgradeable when Scheduler canonicalizes SID fields to the account name.",
  );

  registeredXml = v2Definition;
  const v2RemoveResult = await backend.uninstall(request);
  assert(
    v2RemoveResult.status === "not-installed" && registeredXml === "",
    "A Lifeline v2 task with the same root and recognized stable action must remain safely removable.",
  );

  let foreignBeforeDeleteQueryCount = 0;
  let foreignBeforeDeleteCount = 0;
  const foreignBeforeDeleteRunner = async (args) => {
    if (args[0] === "/Query") {
      foreignBeforeDeleteQueryCount += 1;
      return {
        code: 0,
        stdout:
          foreignBeforeDeleteQueryCount === 1
            ? firstDefinition
            : foreignReplacementDefinition,
        stderr: "",
      };
    }
    if (args[0] === "/Delete") {
      foreignBeforeDeleteCount += 1;
      throw new Error("Foreign replacement must not be deleted.");
    }
    throw new Error(
      `Unexpected pre-delete foreign fixture call: ${args.join(" ")}`,
    );
  };
  const foreignBeforeDeleteBackend = createWindowsTaskSchedulerBackend(
    foreignBeforeDeleteRunner,
    options,
  );
  const foreignBeforeDeleteResult =
    await foreignBeforeDeleteBackend.uninstall(request);
  assert(
    foreignBeforeDeleteResult.ok === false &&
      foreignBeforeDeleteResult.status === "installed" &&
      foreignBeforeDeleteResult.detail.includes(
        "changed after ownership inspection",
      ) &&
      foreignBeforeDeleteCount === 0 &&
      foreignBeforeDeleteQueryCount === 2,
    "Disable must re-read the exact inspected XML immediately before /Delete and preserve a foreign replacement without mutation.",
  );

  let absentBeforeDeleteQueryCount = 0;
  let absentBeforeDeleteCount = 0;
  const absentBeforeDeleteRunner = async (args) => {
    if (args[0] === "/Query") {
      absentBeforeDeleteQueryCount += 1;
      return absentBeforeDeleteQueryCount === 1
        ? { code: 0, stdout: firstDefinition, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Delete") {
      absentBeforeDeleteCount += 1;
      throw new Error("Already-absent task must not be deleted.");
    }
    throw new Error(
      `Unexpected pre-delete absent fixture call: ${args.join(" ")}`,
    );
  };
  const absentBeforeDeleteBackend = createWindowsTaskSchedulerBackend(
    absentBeforeDeleteRunner,
    options,
  );
  const absentBeforeDeleteResult =
    await absentBeforeDeleteBackend.uninstall(request);
  assert(
    absentBeforeDeleteResult.ok !== false &&
      absentBeforeDeleteResult.status === "not-installed" &&
      absentBeforeDeleteResult.detail.includes("became absent") &&
      absentBeforeDeleteCount === 0 &&
      absentBeforeDeleteQueryCount === 2,
    "Disable must accept verified concurrent absence after ownership inspection without issuing /Delete.",
  );

  const differentRoot = path.join(tempRoot, "different-runtime-home");
  registeredXml = v2Definition
    .replaceAll(runtimeRoot, differentRoot)
    .replaceAll(runtimeRoot.replaceAll("&", "&amp;"), differentRoot);
  const createsBeforeDifferentRoot = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeDifferentRoot = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const differentRootInstall = await backend.install(request);
  const differentRootUninstall = await backend.uninstall(request);
  assert(
    differentRootInstall.ok === false &&
      differentRootUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeDifferentRoot &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeDifferentRoot,
    "A Lifeline-looking v2 task for a different canonical root must be rejected without mutation.",
  );

  registeredXml = v2Definition.replaceAll(
    "S-1-5-21-111-222-333-1001",
    "S-1-5-21-999-888-777-1002",
  );
  const createsBeforeDifferentUser = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeDifferentUser = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const differentUserInstall = await backend.install(request);
  const differentUserUninstall = await backend.uninstall(request);
  assert(
    differentUserInstall.ok === false &&
      differentUserUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeDifferentUser &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeDifferentUser,
    "A Lifeline-looking same-root v2 task assigned to another user must be rejected without mutation.",
  );

  registeredXml = v2Definition.replace(
    " restore</Arguments>",
    " status</Arguments>",
  );
  const foreignActionInstall = await backend.install(request);
  const foreignActionUninstall = await backend.uninstall(request);
  assert(
    foreignActionInstall.ok === false &&
      foreignActionUninstall.ok === false &&
      registeredXml.includes(" status</Arguments>"),
    "A Lifeline-looking v2 task with a foreign action must be rejected without mutation.",
  );

  registeredXml = `<?xml version="1.0"?><Task><RegistrationInfo><Author>Foreign</Author><Description>Foreign task</Description><URI>\\LifelineRestoreAtLogon</URI></RegistrationInfo></Task>`;
  const createsBeforeConflict = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  const deletesBeforeConflict = invocations.filter(
    ([command]) => command === "/Delete",
  ).length;
  const conflictInstall = await backend.install(request);
  const conflictUninstall = await backend.uninstall(request);
  assert(
    conflictInstall.ok === false &&
      conflictUninstall.ok === false &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeConflict &&
      invocations.filter(([command]) => command === "/Delete").length ===
        deletesBeforeConflict &&
      registeredXml.includes("<Author>Foreign</Author>"),
    "Foreign same-name task definitions must be rejected without overwrite or removal.",
  );

  registeredXml = firstDefinition;
  const uninstallResult = await backend.uninstall(request);
  assert(
    uninstallResult.status === "not-installed" &&
      registeredXml === "" &&
      uninstallResult.detail.includes("verified its absence"),
    "Exact Lifeline-owned Windows task removal must query and verify absence.",
  );

  const stickyDeleteXml = firstDefinition;
  const stickyDeleteInvocations = [];
  const stickyDeleteRunner = async (args) => {
    stickyDeleteInvocations.push([...args]);
    if (args[0] === "/Query") {
      return { code: 0, stdout: stickyDeleteXml, stderr: "" };
    }
    if (args[0] === "/Delete") {
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(`Unexpected sticky-delete fixture call: ${args.join(" ")}`);
  };
  const stickyDeleteBackend = createWindowsTaskSchedulerBackend(
    stickyDeleteRunner,
    options,
  );
  const stickyDeleteResult = await stickyDeleteBackend.uninstall(request);
  assert(
    stickyDeleteResult.ok === false &&
      stickyDeleteResult.status === "installed" &&
      stickyDeleteResult.detail.includes("still present") &&
      stickyDeleteXml === firstDefinition &&
      stickyDeleteInvocations.filter(([command]) => command === "/Query")
        .length === 3,
    "A successful scheduler delete response must fail closed when exact readback still finds the task.",
  );

  let rollbackXml = "";
  const rollbackInvocations = [];
  const rollbackRunner = async (args) => {
    rollbackInvocations.push([...args]);
    if (args[0] === "/Query") {
      return rollbackXml
        ? { code: 0, stdout: rollbackXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      const xmlPath = args[args.indexOf("/XML") + 1];
      rollbackXml = (await readFile(xmlPath, "utf8")).replace(
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
      );
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (args[0] === "/Delete") {
      rollbackXml = "";
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(
      `Unexpected rollback schtasks fixture call: ${args.join(" ")}`,
    );
  };
  const rollbackBackend = createWindowsTaskSchedulerBackend(
    rollbackRunner,
    options,
  );
  const rollbackResult = await rollbackBackend.install(request);
  assert(
    rollbackResult.ok === false &&
      rollbackResult.status === "installed" &&
      rollbackResult.detail.includes("observed task was preserved") &&
      rollbackXml.includes("<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>") &&
      !rollbackInvocations.some(([command]) => command === "/Delete"),
    "An absent-state create whose exact readback drifts must fail closed without deleting a task that may belong to a concurrent enable.",
  );

  let upgradeRollbackXml = v2Definition;
  let upgradeCreateCount = 0;
  let upgradeCreateAttempted = false;
  const upgradeRollbackInvocations = [];
  const upgradeDefinitionPaths = [];
  const upgradeRollbackRunner = async (args) => {
    upgradeRollbackInvocations.push([...args]);
    if (args[0] === "/Query") {
      if (!upgradeCreateAttempted) {
        return { code: 0, stdout: v2Definition, stderr: "" };
      }
      return upgradeRollbackXml
        ? { code: 0, stdout: upgradeRollbackXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      upgradeCreateCount += 1;
      upgradeCreateAttempted = true;
      const xmlPath = args[args.indexOf("/XML") + 1];
      upgradeDefinitionPaths.push(xmlPath);
      const requestedXml = await readFile(xmlPath, "utf8");
      upgradeRollbackXml = upgradeCreateCount === 1 ? "" : requestedXml;
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (args[0] === "/Delete") {
      upgradeRollbackXml = "";
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(
      `Unexpected upgrade rollback fixture call: ${args.join(" ")}`,
    );
  };
  const upgradeRollbackBackend = createWindowsTaskSchedulerBackend(
    upgradeRollbackRunner,
    options,
  );
  const upgradeRollbackResult = await upgradeRollbackBackend.install(request);
  assert(
    upgradeRollbackResult.ok === false &&
      upgradeRollbackResult.detail.includes(
        "exact prior Lifeline-owned definition was restored and verified",
      ) &&
      upgradeRollbackXml === v2Definition &&
      upgradeCreateCount === 2 &&
      upgradeRollbackInvocations
        .filter(([command]) => command === "/Create")[0]
        ?.includes("/F") &&
      !upgradeRollbackInvocations
        .filter(([command]) => command === "/Create")[1]
        ?.includes("/F") &&
      new Set(upgradeDefinitionPaths).size === 2 &&
      (
        await Promise.all(
          upgradeDefinitionPaths.map((xmlPath) =>
            access(xmlPath)
              .then(() => true)
              .catch(() => false),
          ),
        )
      ).every((exists) => !exists) &&
      !upgradeRollbackInvocations.some(([command]) => command === "/Delete"),
    "A successful owned-drift scheduler mutation whose readback proves the task missing must restore and verify the exact prior v2 definition through a distinct cleaned invocation-owned XML file without deleting it.",
  );

  let foreignBeforeRollbackQueryCount = 0;
  let foreignBeforeRollbackCreateCount = 0;
  const foreignBeforeRollbackInvocations = [];
  const foreignBeforeRollbackRunner = async (args) => {
    foreignBeforeRollbackInvocations.push([...args]);
    if (args[0] === "/Query") {
      foreignBeforeRollbackQueryCount += 1;
      if (foreignBeforeRollbackQueryCount <= 2) {
        return { code: 0, stdout: v2Definition, stderr: "" };
      }
      if (foreignBeforeRollbackQueryCount <= 4) {
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
        };
      }
      return { code: 0, stdout: foreignReplacementDefinition, stderr: "" };
    }
    if (args[0] === "/Create") {
      foreignBeforeRollbackCreateCount += 1;
      if (foreignBeforeRollbackCreateCount === 1) {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error("Rollback must not overwrite a foreign replacement.");
    }
    throw new Error(
      `Unexpected pre-rollback foreign fixture call: ${args.join(" ")}`,
    );
  };
  const foreignBeforeRollbackBackend = createWindowsTaskSchedulerBackend(
    foreignBeforeRollbackRunner,
    options,
  );
  const foreignBeforeRollbackResult =
    await foreignBeforeRollbackBackend.install(request);
  assert(
    foreignBeforeRollbackResult.ok === false &&
      foreignBeforeRollbackResult.status === "installed" &&
      foreignBeforeRollbackResult.detail.includes(
        "rollback found a different task definition",
      ) &&
      foreignBeforeRollbackCreateCount === 1 &&
      foreignBeforeRollbackQueryCount === 5 &&
      !foreignBeforeRollbackInvocations.some(
        ([command]) => command === "/Delete",
      ),
    "Owned-upgrade rollback must re-read immediately before restoration and preserve a foreign replacement without /Create /F.",
  );

  let failedAbsentCreateXml = "";
  const failedAbsentCreateInvocations = [];
  const failedAbsentCreateRunner = async (args) => {
    failedAbsentCreateInvocations.push([...args]);
    if (args[0] === "/Query") {
      return failedAbsentCreateXml
        ? { code: 0, stdout: failedAbsentCreateXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      const xmlPath = args[args.indexOf("/XML") + 1];
      failedAbsentCreateXml = await readFile(xmlPath, "utf8");
      return {
        code: 1,
        stdout: "",
        stderr: "fixture ambiguous create failure",
      };
    }
    if (args[0] === "/Delete") {
      failedAbsentCreateXml = "";
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(
      `Unexpected failed-absent-create fixture call: ${args.join(" ")}`,
    );
  };
  const failedAbsentCreateBackend = createWindowsTaskSchedulerBackend(
    failedAbsentCreateRunner,
    options,
  );
  const failedAbsentCreateResult =
    await failedAbsentCreateBackend.install(request);
  assert(
    failedAbsentCreateResult.ok !== false &&
      failedAbsentCreateResult.status === "installed" &&
      failedAbsentCreateResult.detail.includes("enable converged") &&
      failedAbsentCreateResult.detail.includes("concurrent registration") &&
      failedAbsentCreateXml !== "" &&
      !failedAbsentCreateInvocations.some(([command]) => command === "/Delete"),
    "When concurrent enables both inspect absence, the losing create must accept the winning exact-v4 task as installed convergence without deleting it.",
  );

  let conflictingConcurrentXml = "";
  const conflictingConcurrentInvocations = [];
  const conflictingConcurrentRunner = async (args) => {
    conflictingConcurrentInvocations.push([...args]);
    if (args[0] === "/Query") {
      return conflictingConcurrentXml
        ? { code: 0, stdout: conflictingConcurrentXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      const xmlPath = args[args.indexOf("/XML") + 1];
      conflictingConcurrentXml = (await readFile(xmlPath, "utf8")).replace(
        "<Author>Lifeline</Author>",
        "<Author>Foreign</Author>",
      );
      return {
        code: 1,
        stdout: "",
        stderr: "fixture conflicting concurrent create",
      };
    }
    if (args[0] === "/Delete") {
      throw new Error("Conflicting concurrent task must never be deleted.");
    }
    throw new Error(
      `Unexpected conflicting-concurrent fixture call: ${args.join(" ")}`,
    );
  };
  const conflictingConcurrentBackend = createWindowsTaskSchedulerBackend(
    conflictingConcurrentRunner,
    options,
  );
  const conflictingConcurrentResult =
    await conflictingConcurrentBackend.install(request);
  assert(
    conflictingConcurrentResult.ok === false &&
      conflictingConcurrentResult.status === "installed" &&
      conflictingConcurrentResult.detail.includes(
        "observed task was preserved",
      ) &&
      conflictingConcurrentXml.includes("<Author>Foreign</Author>") &&
      !conflictingConcurrentInvocations.some(
        ([command]) => command === "/Delete",
      ),
    "A losing absent-state create that reads a foreign or non-exact concurrent task must preserve it and fail closed without deletion authority.",
  );

  let failedUpgradeChangedXml = v2Definition;
  let failedUpgradeChangedCreates = 0;
  const failedUpgradeChangedInvocations = [];
  const failedUpgradeChangedRunner = async (args) => {
    failedUpgradeChangedInvocations.push([...args]);
    if (args[0] === "/Query") {
      return { code: 0, stdout: failedUpgradeChangedXml, stderr: "" };
    }
    if (args[0] === "/Create") {
      failedUpgradeChangedCreates += 1;
      const xmlPath = args[args.indexOf("/XML") + 1];
      const requestedXml = await readFile(xmlPath, "utf8");
      if (failedUpgradeChangedCreates === 1) {
        failedUpgradeChangedXml = requestedXml.replace(
          "<Author>Lifeline</Author>",
          "<Author>Foreign</Author>",
        );
        return {
          code: 1,
          stdout: "",
          stderr: "fixture failed after replacing definition",
        };
      }
      failedUpgradeChangedXml = requestedXml;
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(
      `Unexpected failed-upgrade-change fixture call: ${args.join(" ")}`,
    );
  };
  const failedUpgradeChangedBackend = createWindowsTaskSchedulerBackend(
    failedUpgradeChangedRunner,
    options,
  );
  const failedUpgradeChangedResult =
    await failedUpgradeChangedBackend.install(request);
  assert(
    failedUpgradeChangedResult.ok === false &&
      failedUpgradeChangedResult.status === "installed" &&
      failedUpgradeChangedResult.detail.includes(
        "observed definition was preserved",
      ) &&
      failedUpgradeChangedXml.includes("<Author>Foreign</Author>") &&
      failedUpgradeChangedCreates === 1 &&
      !failedUpgradeChangedInvocations.some(
        ([command]) => command === "/Delete",
      ),
    "A nonzero owned-upgrade create that reads a different or foreign definition must preserve it and fail closed without restoring stale prior XML.",
  );

  let concurrentUpgradeXml = v2Definition;
  let concurrentUpgradeCreates = 0;
  const concurrentUpgradeInvocations = [];
  const concurrentUpgradeRunner = async (args) => {
    concurrentUpgradeInvocations.push([...args]);
    if (args[0] === "/Query") {
      return { code: 0, stdout: concurrentUpgradeXml, stderr: "" };
    }
    if (args[0] === "/Create") {
      concurrentUpgradeCreates += 1;
      const xmlPath = args[args.indexOf("/XML") + 1];
      concurrentUpgradeXml = await readFile(xmlPath, "utf8");
      return {
        code: 1,
        stdout: "",
        stderr: "fixture concurrent upgrade winner",
      };
    }
    throw new Error(
      `Unexpected concurrent-upgrade fixture call: ${args.join(" ")}`,
    );
  };
  const concurrentUpgradeBackend = createWindowsTaskSchedulerBackend(
    concurrentUpgradeRunner,
    options,
  );
  const concurrentUpgradeResult =
    await concurrentUpgradeBackend.install(request);
  assert(
    concurrentUpgradeResult.ok !== false &&
      concurrentUpgradeResult.status === "installed" &&
      concurrentUpgradeResult.detail.includes("enable converged") &&
      concurrentUpgradeResult.detail.includes(
        "without restoring stale prior XML",
      ) &&
      concurrentUpgradeCreates === 1 &&
      concurrentUpgradeXml !== v2Definition &&
      !concurrentUpgradeInvocations.some(([command]) => command === "/Delete"),
    "When two owned-drift upgrades race, a failed creator that reads the exact current-v4 winner must accept convergence without restoring stale prior XML.",
  );

  let missingUpgradeXml = v2Definition;
  let missingUpgradeCreates = 0;
  const missingUpgradeInvocations = [];
  const missingUpgradeRunner = async (args) => {
    missingUpgradeInvocations.push([...args]);
    if (args[0] === "/Query") {
      return missingUpgradeXml
        ? { code: 0, stdout: missingUpgradeXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      missingUpgradeCreates += 1;
      missingUpgradeXml = "";
      return {
        code: 1,
        stdout: "",
        stderr: "fixture failed upgrade left task absent",
      };
    }
    throw new Error(
      `Unexpected missing-upgrade fixture call: ${args.join(" ")}`,
    );
  };
  const missingUpgradeBackend = createWindowsTaskSchedulerBackend(
    missingUpgradeRunner,
    options,
  );
  const missingUpgradeResult = await missingUpgradeBackend.install(request);
  assert(
    missingUpgradeResult.ok === false &&
      missingUpgradeResult.status === "not-installed" &&
      missingUpgradeResult.detail.includes("disappeared") &&
      missingUpgradeResult.detail.includes("did not restore") &&
      missingUpgradeCreates === 1 &&
      missingUpgradeXml === "" &&
      !missingUpgradeInvocations.some(([command]) => command === "/Delete"),
    "A nonzero owned-upgrade create followed by verified absence must fail closed without claiming rollback authority or recreating stale prior XML.",
  );

  const unchangedPriorXml = v2Definition;
  let unchangedPriorCreates = 0;
  const unchangedPriorRunner = async (args) => {
    if (args[0] === "/Query") {
      return { code: 0, stdout: unchangedPriorXml, stderr: "" };
    }
    if (args[0] === "/Create") {
      unchangedPriorCreates += 1;
      return { code: 1, stdout: "", stderr: "fixture create rejected" };
    }
    throw new Error(
      `Unexpected unchanged-prior fixture call: ${args.join(" ")}`,
    );
  };
  const unchangedPriorBackend = createWindowsTaskSchedulerBackend(
    unchangedPriorRunner,
    options,
  );
  const unchangedPriorResult = await unchangedPriorBackend.install(request);
  assert(
    unchangedPriorResult.ok === false &&
      unchangedPriorResult.status === "installed" &&
      unchangedPriorResult.detail.includes(
        "exact prior Lifeline-owned definition remains installed, unchanged, and verified",
      ) &&
      unchangedPriorXml === v2Definition &&
      unchangedPriorCreates === 1,
    "A rejected owned-upgrade create must verify an unchanged exact prior definition without rewriting or deleting it.",
  );

  registeredXml = firstDefinition;
  const stableLauncherCli = path.join(launcherDirectory, "cli.js");
  const createsBeforeStableSource = invocations.filter(
    ([command]) => command === "/Create",
  ).length;
  await rm(sourceDirectory, { recursive: true, force: true });
  const stableSourceBackend = createWindowsTaskSchedulerBackend(runner, {
    ...options,
    cliEntrypoint: stableLauncherCli,
  });
  const stableSourceInspection = await stableSourceBackend.inspect();
  const stableSourceReenable = await stableSourceBackend.install(request);
  assert(
    stableSourceInspection.status === "installed" &&
      stableSourceReenable.status === "installed" &&
      invocations.filter(([command]) => command === "/Create").length ===
        createsBeforeStableSource &&
      registeredXml === firstDefinition &&
      !(await access(sourceDirectory)
        .then(() => true)
        .catch(() => false)),
    "A surviving exact launcher snapshot must inspect and re-enable as a no-op after the owner source directory is gone.",
  );

  const recoveryRuntimeRoot = path.join(tempRoot, "snapshot-recovery-runtime");
  let recoveryXml = "";
  let recoveryCreates = 0;
  const recoveryRunner = async (args) => {
    if (args[0] === "/Query") {
      return recoveryXml
        ? { code: 0, stdout: recoveryXml, stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "ERROR: The system cannot find the file specified.",
          };
    }
    if (args[0] === "/Create") {
      recoveryCreates += 1;
      recoveryXml = await readFile(args[args.indexOf("/XML") + 1], "utf8");
      return { code: 0, stdout: "SUCCESS", stderr: "" };
    }
    throw new Error(
      `Unexpected stable-source recovery fixture call: ${args.join(" ")}`,
    );
  };
  const recoveryBackend = createWindowsTaskSchedulerBackend(recoveryRunner, {
    ...options,
    rootDirectory: recoveryRuntimeRoot,
    cliEntrypoint: stableLauncherCli,
  });
  const recoveryInstall = await recoveryBackend.install(request);
  const recoveryDefinition = recoveryXml;
  const recoveryStartupDirectory = path.join(
    recoveryRuntimeRoot,
    ".lifeline",
    "startup",
    "windows",
  );
  const recoveryLauncherName = (await readdir(recoveryStartupDirectory)).find(
    (name) => name.startsWith("launcher-"),
  );
  assert(
    recoveryInstall.status === "installed" && recoveryLauncherName,
    "A surviving launcher snapshot must seed an external recovery runtime without copying generated metadata as payload.",
  );
  const recoveryLauncherDirectory = path.join(
    recoveryStartupDirectory,
    recoveryLauncherName,
  );
  const recoverySupportPath = path.join(
    recoveryLauncherDirectory,
    "support.js",
  );
  await writeFile(
    recoverySupportPath,
    "export const fixture = false;\n",
    "utf8",
  );
  const recoveryRepair = await recoveryBackend.install(request);
  const recoveryNoop = await recoveryBackend.install(request);
  const recoveryInspection = await recoveryBackend.inspect();
  assert(
    recoveryRepair.status === "installed" &&
      recoveryNoop.status === "installed" &&
      recoveryInspection.status === "installed" &&
      recoveryCreates === 1 &&
      recoveryXml === recoveryDefinition &&
      (await readFile(recoverySupportPath, "utf8")) ===
        (await readFile(path.join(launcherDirectory, "support.js"), "utf8")) &&
      (await readdir(recoveryLauncherDirectory)).filter(
        (name) => name === "launcher.json",
      ).length === 1,
    "A surviving stable launcher must byte-repair an external snapshot, preserve exact task identity, and then re-enable as a no-op.",
  );

  const expectedQueryArgs = ["/Query", "/TN", "LifelineRestoreAtLogon", "/XML"];
  assert(
    invocations
      .filter(([command]) => command === "/Query")
      .every(
        (args) => JSON.stringify(args) === JSON.stringify(expectedQueryArgs),
      ),
    "Every Windows task query/readback must use the documented exact-task /XML flag form without an optional XML type token.",
  );
}

async function verifyAixInittabBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const startupBackendAixModule = await import(
    new URL("../dist/core/startup-backends/aix-inittab.js", import.meta.url)
  );
  const { createAixInittabBackend } = startupBackendAixModule;

  let inittabEntry = "";
  const invocations = [];

  const runner = async (command, args) => {
    invocations.push([command, ...args]);

    if (command === "lsitab") {
      if (!inittabEntry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      return { code: 0, stdout: inittabEntry, stderr: "" };
    }

    if (command === "mkitab" || command === "chitab") {
      [inittabEntry] = args;
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "rmitab") {
      if (!inittabEntry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      inittabEntry = "";
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(
      `Unexpected AIX backend invocation: ${command} ${args.join(" ")}`,
    );
  };

  const backend = createAixInittabBackend(runner);

  const initialInspection = await backend.inspect();
  assert(
    initialInspection.status === "not-installed",
    `Expected initial AIX inspect status not-installed, got ${initialInspection.status}.`,
  );

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected AIX dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("Dry-run:"),
    `Expected AIX dry-run install detail marker, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected AIX install status installed, got ${installResult.status}.`,
  );

  inittabEntry = "llrestore:2:once:/bin/sh -lc 'echo drift'";
  const driftedInspection = await backend.inspect();
  assert(
    driftedInspection.status === "not-installed",
    `Expected drifted AIX inspect status not-installed, got ${driftedInspection.status}.`,
  );

  const reconcileResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    reconcileResult.status === "installed",
    `Expected AIX reconcile install status installed, got ${reconcileResult.status}.`,
  );

  const inspectAfterInstall = await backend.inspect();
  assert(
    inspectAfterInstall.status === "installed",
    `Expected AIX inspect status installed after install, got ${inspectAfterInstall.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.status === "installed",
    `Expected AIX dry-run uninstall status installed, got ${dryRunUninstall.status}.`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected AIX uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const inspectAfterUninstall = await backend.inspect();
  assert(
    inspectAfterUninstall.status === "not-installed",
    `Expected AIX inspect status not-installed after uninstall, got ${inspectAfterUninstall.status}.`,
  );

  const mutationCommands = invocations
    .filter(
      ([command]) =>
        command === "mkitab" || command === "chitab" || command === "rmitab",
    )
    .map(([command]) => command);

  assert(
    mutationCommands.includes("mkitab") &&
      mutationCommands.includes("chitab") &&
      mutationCommands.includes("rmitab"),
    `Expected AIX install/update/uninstall command coverage, got ${mutationCommands.join(", ")}.`,
  );
}

async function verifyLaunchdBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendLaunchdModule = await import(
    new URL("../dist/core/startup-backends/launchd.js", import.meta.url)
  );
  const { createLaunchdBackend } = startupBackendLaunchdModule;

  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-launchd-backend-"),
  );
  const invoked = [];

  const runner = async (args) => {
    invoked.push(args);

    if (args.join(" ") === "print gui/502/io.lifeline.restore") {
      return {
        code: 1,
        stdout: "",
        stderr:
          'Could not find service "io.lifeline.restore" in domain for user gui/502',
      };
    }

    if (args.join(" ") === "bootout gui/502/io.lifeline.restore") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (
      args.join(" ") ===
      `bootstrap gui/502 ${path.join(tempHome, "Library", "LaunchAgents", "io.lifeline.restore.plist")}`
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(
      `Unexpected launchctl invocation in deterministic test: ${args.join(" ")}`,
    );
  };

  const backend = createLaunchdBackend(runner, {
    homeDirectory: tempHome,
    uid: 502,
  });

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected launchd dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("would write") &&
      dryRunInstall.detail.includes("bootstrap io.lifeline.restore"),
    `Expected launchd dry-run install detail to describe plist/bootstrap intent, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected launchd install status installed, got ${installResult.status}.`,
  );

  const plistPath = path.join(
    tempHome,
    "Library",
    "LaunchAgents",
    "io.lifeline.restore.plist",
  );
  const rawPlist = await readFile(plistPath, "utf8");
  assert(
    rawPlist.includes("<string>lifeline</string>") &&
      rawPlist.includes("<string>restore</string>"),
    `Expected installed launchd plist to keep canonical restore entrypoint.\n${rawPlist}`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes(
      "LaunchAgent io.lifeline.restore is not present",
    ) ||
      dryRunUninstall.detail.includes(
        "would bootout LaunchAgent io.lifeline.restore",
      ),
    `Expected launchd dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected launchd uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const invokedCommands = invoked.map((command) => command.join(" "));
  assert(
    invokedCommands.includes(`bootstrap gui/502 ${plistPath}`),
    `Expected launchd install path to run bootstrap.\ncommands:\n${invokedCommands.join("\n")}`,
  );
  assert(
    invokedCommands.includes("bootout gui/502/io.lifeline.restore"),
    `Expected launchd uninstall path to run bootout.\ncommands:\n${invokedCommands.join("\n")}`,
  );
}

async function verifySystemdBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendSystemdModule = await import(
    new URL("../dist/core/startup-backends/systemd.js", import.meta.url)
  );
  const { createSystemdUserBackend } = startupBackendSystemdModule;

  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-systemd-backend-"),
  );
  const invoked = [];

  const runner = async (args) => {
    invoked.push(args);

    if (args.join(" ") === "--user cat lifeline-restore.service") {
      return {
        code: 1,
        stdout: "",
        stderr: "Unit lifeline-restore.service could not be found.",
      };
    }

    if (args.join(" ") === "--user daemon-reload") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args.join(" ") === "--user enable --now lifeline-restore.service") {
      return { code: 0, stdout: "Created symlink.", stderr: "" };
    }

    if (args.join(" ") === "--user disable --now lifeline-restore.service") {
      return { code: 0, stdout: "Removed symlink.", stderr: "" };
    }

    throw new Error(
      `Unexpected systemctl invocation in deterministic test: ${args.join(" ")}`,
    );
  };

  const backend = createSystemdUserBackend(runner, { homeDirectory: tempHome });

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes(
      "would write user unit lifeline-restore.service",
    ),
    `Expected dry-run install detail to describe unit creation, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected install status installed, got ${installResult.status}.`,
  );
  const unitPath = path.join(
    tempHome,
    ".config",
    "systemd",
    "user",
    "lifeline-restore.service",
  );
  const rawUnit = await readFile(unitPath, "utf8");
  assert(
    rawUnit.includes("ExecStart=lifeline restore"),
    `Expected installed unit file to keep canonical restore entrypoint.
${rawUnit}`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes(
      "user unit lifeline-restore.service is not present",
    ) ||
      dryRunUninstall.detail.includes(
        "would disable user unit lifeline-restore.service",
      ),
    `Expected dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const invokedCommands = invoked.map((command) => command.join(" "));
  assert(
    invokedCommands.includes("--user daemon-reload") &&
      invokedCommands.includes("--user enable --now lifeline-restore.service"),
    `Expected install path to run daemon-reload and enable --now.
commands:
${invokedCommands.join("\n")}`,
  );
  assert(
    invokedCommands.includes("--user disable --now lifeline-restore.service"),
    `Expected uninstall path to run disable --now.
commands:
${invokedCommands.join("\n")}`,
  );
}

async function main() {
  await verifyRestoreEntrypointWiring();
  await verifyContractSurfaceWiring();
  await verifySeamInstallDisableStatusAndDryRun();
  await verifyBackendResolutionCoverageAndFallback();
  await verifyWindowsTaskSchedulerBackendDeterministicBehavior();
  await verifyFreebsdRcDBackendDeterministicBehavior();
  await verifyAixInittabBackendDeterministicBehavior();
  await verifyLaunchdBackendDeterministicBehavior();
  await verifySystemdBackendDeterministicBehavior();
  console.log("Wave 2 startup deterministic verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wave 2 startup deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
