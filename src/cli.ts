#!/usr/bin/env node
import { runDownCommand } from "./commands/down.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runExecuteCommand } from "./commands/execute.js";
import { runLogsCommand } from "./commands/logs.js";
import { runProofPassCommand } from "./commands/proof-pass.js";
import { runReleaseCommand } from "./commands/release.js";
import { runResolveCommand } from "./commands/resolve.js";
import { runRestartCommand } from "./commands/restart.js";
import { runRestoreCommand } from "./commands/restore.js";
import { runStartupCommand } from "./commands/startup.js";
import { runStatusCommand } from "./commands/status.js";
import { runUpCommand } from "./commands/up.js";
import { runValidateCommand } from "./commands/validate.js";
import { LifelineError } from "./core/errors.js";
import { configureLifelineInvocation } from "./core/lifeline-root.js";
import { runSupervisor } from "./core/supervisor.js";

function printUsage(): void {
  console.log(
    "Lifeline v1 + Wave 2 startup and execution contracts\n\nGlobal runtime-home option:\n  --root <path> | --root=<path>  (overrides LIFELINE_ROOT and defaults to the invoking cwd)\n\nUsage:\n  lifeline [--root <path>] doctor\n  lifeline [--root <path>] validate <manifest-path> [--playbook-path <path>]\n  lifeline [--root <path>] resolve <manifest-path> [--playbook-path <path>]\n  lifeline [--root <path>] up <manifest-path> [--playbook-path <path>]\n  lifeline [--root <path>] down <app-name>\n  lifeline [--root <path>] status <app-name> [--proof|--proof-text] [--proof-gate]\n  lifeline [--root <path>] logs <app-name> [line-count]\n  lifeline [--root <path>] restart <app-name> [--playbook-path <path>]\n  lifeline [--root <path>] restore\n  lifeline [--root <path>] startup <enable|disable|status> [--dry-run]\n  lifeline [--root <path>] release <plan|persist> <deploy-manifest>\n  lifeline [--root <path>] release activate <app-name> <release-id> [--yes|--confirm]\n  lifeline [--root <path>] release rollback <app-name> [--yes|--confirm]\n  lifeline [--root <path>] execute <request-path> --capability-profile <path> --approval-receipt <path> [--receipt-dir <path>]\n  lifeline [--root <path>] proof-pass <proof-summary-path> --source-repo <id> --tranche <id> [--receipt-dir <path>]",
  );
}

function parsePlaybookOption(args: string[]): {
  target?: string | undefined;
  option?: string | undefined;
  playbookPath?: string | undefined;
  statusProofMode?: "json" | "text" | undefined;
  enforceProofGate?: boolean | undefined;
} {
  const positional: string[] = [];
  let playbookPath: string | undefined;
  let statusProofMode: "json" | "text" | undefined;
  let enforceProofGate = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--playbook-path") {
      const nextArg = args[index + 1];
      if (!nextArg) {
        throw new LifelineError(
          "Missing value for --playbook-path.",
          "CLI_ARGUMENT_ERROR",
        );
      }
      playbookPath = nextArg;
      index += 1;
      continue;
    }

    if (arg === "--proof" || arg === "--proof-json") {
      statusProofMode = "json";
      continue;
    }

    if (arg === "--proof-text") {
      statusProofMode = "text";
      continue;
    }

    if (arg === "--enforce-proof-gate" || arg === "--proof-gate") {
      enforceProofGate = true;
      continue;
    }
    positional.push(arg);
  }

  return {
    target: positional[0],
    option: positional[1],
    ...(playbookPath ? { playbookPath } : {}),
    ...(statusProofMode ? { statusProofMode } : {}),
    ...(enforceProofGate ? { enforceProofGate } : {}),
  };
}

async function main(argv: string[]): Promise<number> {
  const invocation = configureLifelineInvocation({ argv });
  const [command, ...rest] = invocation.argv;
  const { target, option, playbookPath, statusProofMode, enforceProofGate } =
    parsePlaybookOption(rest);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  switch (command) {
    case "doctor":
      if (target || option || playbookPath || statusProofMode || enforceProofGate) {
        console.error("The doctor command does not accept arguments.");
        printUsage();
        return 1;
      }
      return runDoctorCommand();
    case "validate":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runValidateCommand(target, playbookPath);
    case "resolve":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runResolveCommand(target, playbookPath);
    case "up":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runUpCommand(target, playbookPath);
    case "down":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runDownCommand(target);
    case "status":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runStatusCommand(target, {
        ...(statusProofMode === "json" ? { mode: "proof-json" as const } : {}),
        ...(statusProofMode === "text" ? { mode: "proof-text" as const } : {}),
        ...(enforceProofGate ? { enforceProofGate: true } : {}),
      });
    case "logs": {
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      const parsedLineCount = option ? Number(option) : 100;
      if (!Number.isInteger(parsedLineCount) || parsedLineCount < 1) {
        console.error(`Invalid line count: ${option}`);
        return 1;
      }
      return runLogsCommand(target, parsedLineCount);
    }
    case "restart":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runRestartCommand(target, playbookPath);
    case "restore":
      return runRestoreCommand();
    case "startup":
      return runStartupCommand(target, option);
    case "release":
      return runReleaseCommand(rest);
    case "execute":
      return runExecuteCommand(rest);
    case "proof-pass":
      return runProofPassCommand(rest);
    case "supervise":
      if (!target) {
        console.error("Missing app name.");
        return 1;
      }
      return runSupervisor(target);
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof LifelineError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected error: ${message}`);
    process.exitCode = 1;
  });
