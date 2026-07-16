import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
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
      cliSource.includes('runRestoreCommand({ startup: target === "--startup" })'),
    "Expected CLI usage output to keep the restore command discoverable.",
  );

  await ensureBuiltCli();
  const {
    getStartupRestoreTerminalFailure,
    isPersistedStatusEligibleForRestore,
  } = await import(
    new URL("../dist/commands/restore.js", import.meta.url)
  );
  assert(
    isPersistedStatusEligibleForRestore("stopped") === false &&
      isPersistedStatusEligibleForRestore("stopped", { startup: true }) === true &&
      isPersistedStatusEligibleForRestore("blocked", { startup: true }) === false &&
      isPersistedStatusEligibleForRestore("crash-loop", { startup: true }) === false,
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
    getStartupRestoreTerminalFailure(
      [restored],
      { apps: { playbook: stoppedByDown } },
    ) === undefined,
    "Expected normal lifeline down terminal state to let the startup wrapper succeed.",
  );
  assert(
    getStartupRestoreTerminalFailure(
      [restored],
      {
        apps: {
          playbook: {
            ...stoppedByDown,
            childPid: 4200,
            lastKnownStatus: "running",
            lastExitAt: undefined,
          },
        },
      },
    )?.includes("persisted status is running"),
    "Expected unexpected supervisor disappearance with stale running state to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure([restored], { apps: {} })?.includes(
      "runtime state is missing",
    ),
    "Expected missing restored-app state to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure(
      [restored],
      {
        apps: {
          playbook: { ...stoppedByDown, supervisorPid: 4101 },
        },
      },
    )?.includes("supervisor identity changed"),
    "Expected terminal state for a different supervisor identity to fail closed.",
  );
  assert(
    getStartupRestoreTerminalFailure(
      [restored],
      { apps: { playbook: { ...stoppedByDown, lastExitAt: undefined } } },
    )?.includes("lacks a terminal timestamp"),
    "Expected stale stopped state without a terminal transition for this restore to fail closed.",
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

  const { access, mkdir, mkdtemp, readFile, readdir, writeFile } = await import(
    "node:fs/promises"
  );
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
      registeredXml.includes("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"),
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
  await writeFile(launcherSupportPath, "export const fixture = false;\n", "utf8");
  await writeFile(unexpectedLauncherPath, "throw new Error('foreign');\n", "utf8");
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
    "<RunLevel>LeastPrivilege</RunLevel>",
    "<RunLevel>HighestAvailable</RunLevel>",
  );
  const reconcileResult = await backend.install(request);
  const reconcileCreate = invocations.filter(
    ([command]) => command === "/Create",
  ).at(-1);
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

  const v3Definition = firstDefinition.replace(
    "Windows startup v4.",
    "Windows startup v3.",
  );
  registeredXml = v3Definition;
  const v3UpgradeResult = await backend.install(request);
  assert(
    v3UpgradeResult.status === "installed" &&
      registeredXml === firstDefinition,
    "A recognized same-current-user v3 task must remain upgradeable to the exact v4 definition.",
  );

  const v2Definition = firstDefinition
    .replace("Windows startup v4.", "Windows startup v2.")
    .replace(" restore --startup</Arguments>", " restore</Arguments>");
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
    uninstallResult.status === "not-installed" && registeredXml === "",
    "Exact Lifeline-owned Windows task must remain removable through the backend.",
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
        " restore --startup</Arguments>",
        " status</Arguments>",
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
      rollbackResult.detail.includes("rolled back") &&
      rollbackXml === "" &&
      rollbackInvocations.some(([command]) => command === "/Delete"),
    "A newly created task that fails exact readback must be rolled back through the owned task identity.",
  );

  let upgradeRollbackXml = v2Definition;
  let upgradeCreateCount = 0;
  const upgradeRollbackInvocations = [];
  const upgradeRollbackRunner = async (args) => {
    upgradeRollbackInvocations.push([...args]);
    if (args[0] === "/Query") {
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
      const xmlPath = args[args.indexOf("/XML") + 1];
      const requestedXml = await readFile(xmlPath, "utf8");
      upgradeRollbackXml =
        upgradeCreateCount === 1
          ? requestedXml.replace(
              " restore --startup</Arguments>",
              " status</Arguments>",
            )
          : requestedXml;
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
      !upgradeRollbackInvocations.some(([command]) => command === "/Delete"),
    "A failed owned-drift upgrade must restore and verify the exact prior v2 definition without deleting it.",
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
