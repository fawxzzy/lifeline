import { readFile } from "node:fs/promises";
import { createWindowsTaskSchedulerBackend } from "../dist/core/startup-backends/windows-task-scheduler.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createFakeRunner() {
  const state = {
    installed: false,
    xml: "",
  };

  return async function run(args) {
    const command = args.join(" ");

    if (command.startsWith("/Query")) {
      if (!state.installed) {
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
        };
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
      return {
        code: 0,
        stdout: "SUCCESS: The scheduled task has successfully been created.",
        stderr: "",
      };
    }

    if (command.startsWith("/Delete")) {
      if (!state.installed) {
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
        };
      }

      state.installed = false;
      state.xml = "";
      return {
        code: 0,
        stdout: "SUCCESS: The scheduled task has successfully been deleted.",
        stderr: "",
      };
    }

    return {
      code: 1,
      stdout: "",
      stderr: `Unexpected scheduler command: ${command}`,
    };
  };
}

async function main() {
  const backend = createWindowsTaskSchedulerBackend(createFakeRunner());

  const initialStatus = await backend.inspect();
  assert(
    initialStatus.status === "not-installed",
    `Expected initial status not-installed, got ${initialStatus.status}.`,
  );

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.detail.includes("Dry-run:"),
    "Expected dry-run enable detail to include Dry-run marker.",
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected installed status, got ${installResult.status}.`,
  );

  const statusAfterInstall = await backend.inspect();
  assert(
    statusAfterInstall.status === "installed",
    `Expected installed status after create, got ${statusAfterInstall.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes("Dry-run:"),
    "Expected dry-run disable detail to include Dry-run marker.",
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected not-installed status, got ${uninstallResult.status}.`,
  );

  const finalStatus = await backend.inspect();
  assert(
    finalStatus.status === "not-installed",
    `Expected final status not-installed, got ${finalStatus.status}.`,
  );

  console.log("Deterministic Windows startup backend verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Deterministic Windows startup backend verification failed: ${message}`,
  );
  process.exitCode = 1;
});
