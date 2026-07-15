import path from "node:path";

import { LifelineError } from "./errors.js";

export const LIFELINE_ROOT_ENVIRONMENT_VARIABLE = "LIFELINE_ROOT";

export type LifelineRootSource = "cli" | "environment" | "cwd";

export interface LifelineRootResolution {
  home: string;
  stateDirectory: string;
  source: LifelineRootSource;
}

export interface ConfiguredLifelineInvocation extends LifelineRootResolution {
  argv: string[];
}

function rootUsage(): string {
  return "Use --root <path> or --root=<path>.";
}

function validateRootValue(value: string, source: "cli" | "environment"): void {
  if (value.trim().length > 0 && !value.includes("\0")) {
    return;
  }

  if (source === "cli") {
    throw new LifelineError(
      `The --root value must be a non-empty filesystem path. ${rootUsage()}`,
      "CLI_ARGUMENT_ERROR",
    );
  }

  throw new LifelineError(
    "LIFELINE_ROOT must be a non-empty filesystem path. Set it to a valid path or unset it.",
    "LIFELINE_ROOT_ERROR",
  );
}

export function resolveLifelineRoot(
  options: {
    cliRoot?: string;
    envRoot?: string;
    cwd?: string;
  } = {},
): LifelineRootResolution {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const selected = options.cliRoot ?? options.envRoot;
  const source: LifelineRootSource =
    options.cliRoot !== undefined
      ? "cli"
      : options.envRoot !== undefined
        ? "environment"
        : "cwd";

  if (selected !== undefined) {
    validateRootValue(selected, source === "cli" ? "cli" : "environment");
  }

  let home: string;
  try {
    home = path.normalize(path.resolve(cwd, selected ?? cwd));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LifelineError(
      source === "cli"
        ? `Could not resolve --root as a filesystem path: ${message}. ${rootUsage()}`
        : `Could not resolve LIFELINE_ROOT as a filesystem path: ${message}. Set it to a valid path or unset it.`,
      source === "cli" ? "CLI_ARGUMENT_ERROR" : "LIFELINE_ROOT_ERROR",
    );
  }

  return {
    home,
    stateDirectory: path.join(home, ".lifeline"),
    source,
  };
}

function extractCliRoot(argv: string[]): { argv: string[]; cliRoot?: string } {
  const remaining: string[] = [];
  let cliRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }

    let rootValue: string | undefined;
    if (argument === "--root") {
      const nextArgument = argv[index + 1];
      if (!nextArgument || nextArgument.startsWith("--")) {
        throw new LifelineError(
          `Missing value for --root. ${rootUsage()}`,
          "CLI_ARGUMENT_ERROR",
        );
      }
      rootValue = nextArgument;
      index += 1;
    } else if (argument.startsWith("--root=")) {
      rootValue = argument.slice("--root=".length);
    } else if (argument.startsWith("--root")) {
      throw new LifelineError(
        `Malformed root option: ${argument}. ${rootUsage()}`,
        "CLI_ARGUMENT_ERROR",
      );
    } else {
      remaining.push(argument);
      continue;
    }

    if (cliRoot !== undefined) {
      throw new LifelineError(
        `The --root option may be specified only once. ${rootUsage()}`,
        "CLI_ARGUMENT_ERROR",
      );
    }

    validateRootValue(rootValue, "cli");
    cliRoot = rootValue;
  }

  return {
    argv: remaining,
    ...(cliRoot !== undefined ? { cliRoot } : {}),
  };
}

export function configureLifelineInvocation(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): ConfiguredLifelineInvocation {
  const env = options.env ?? process.env;
  const parsed = extractCliRoot(options.argv);
  const resolution = resolveLifelineRoot({
    ...(parsed.cliRoot !== undefined ? { cliRoot: parsed.cliRoot } : {}),
    ...(env[LIFELINE_ROOT_ENVIRONMENT_VARIABLE] !== undefined
      ? { envRoot: env[LIFELINE_ROOT_ENVIRONMENT_VARIABLE] }
      : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });

  env[LIFELINE_ROOT_ENVIRONMENT_VARIABLE] = resolution.home;

  return {
    ...resolution,
    argv: parsed.argv,
  };
}

export function getLifelineRoot(): string {
  return resolveLifelineRoot({
    ...(process.env[LIFELINE_ROOT_ENVIRONMENT_VARIABLE] !== undefined
      ? { envRoot: process.env[LIFELINE_ROOT_ENVIRONMENT_VARIABLE] }
      : {}),
  }).home;
}

export function getLifelineStateDirectory(): string {
  return path.join(getLifelineRoot(), ".lifeline");
}

export function getLifelineReceiptsDirectory(): string {
  return path.join(getLifelineStateDirectory(), "receipts");
}
