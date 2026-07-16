import { readFile } from "node:fs/promises";
import { createWindowsTaskSchedulerBackend } from "../dist/core/startup-backends/windows-task-scheduler.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createSchedulerHarness() {
  const state = { installed: false, xml: "" };

  return async (args) => {
    const command = args.join(" ");

    if (command.startsWith("/Query")) {
      if (!state.installed) {
        return { code: 1, stdout: "", stderr: "ERROR: task not found." };
      }

      return {
        code: 0,
        stdout: state.xml,
        stderr: "",
      };
    }

    if (command.startsWith("/Create")) {
      const xmlPath = args[args.indexOf("/XML") + 1];
      state.xml = await readFile(xmlPath, "utf8");
      state.installed = true;
      return { code: 0, stdout: "SUCCESS: task created.", stderr: "" };
    }

    if (command.startsWith("/Delete")) {
      state.installed = false;
      state.xml = "";
      return { code: 0, stdout: "SUCCESS: task deleted.", stderr: "" };
    }

    return { code: 1, stdout: "", stderr: `Unexpected command: ${command}` };
  };
}

async function main() {
  const backend = createWindowsTaskSchedulerBackend(createSchedulerHarness());

  const initialStatus = await backend.inspect();
  assert(
    initialStatus.status === "not-installed",
    "Expected initial status to be not-installed.",
  );

  const dryRunEnablePlan = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunEnablePlan.status === "not-installed",
    "Expected dry-run enable status to remain not-installed.",
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    "Expected install mutation to report installed.",
  );

  const statusAfterInstall = await backend.inspect();
  assert(
    statusAfterInstall.status === "installed",
    "Expected inspect to report installed after mutation.",
  );

  const dryRunEnableWhenInstalled = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunEnableWhenInstalled.status === "installed",
    "Expected dry-run enable to reflect installed status.",
  );

  const dryRunDisablePlan = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunDisablePlan.status === "installed",
    "Expected dry-run disable to reflect installed status.",
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    "Expected uninstall mutation to report not-installed.",
  );

  const statusAfterUninstall = await backend.inspect();
  assert(
    statusAfterUninstall.status === "not-installed",
    "Expected inspect to report not-installed after uninstall mutation.",
  );

  console.log(
    "Deterministic startup Windows Task Scheduler harness verification passed.",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Deterministic startup Windows Task Scheduler harness verification failed: ${message}`,
  );
  process.exitCode = 1;
});
