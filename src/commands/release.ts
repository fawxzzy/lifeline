import { readFile } from "node:fs/promises";

type ReleaseAction = "plan" | "persist" | "activate" | "rollback";

type Wave1ReleasePlanResult = {
  validation: {
    status: string;
  };
};

type Wave1ReleaseMutationResult = {
  ok: boolean;
};

type Wave1ReleaseModules = {
  planWave1Release: (
    manifest: unknown,
    options?: { rootDir?: string },
  ) => Wave1ReleasePlanResult & Record<string, unknown>;
  persistWave1Release: (
    manifest: unknown,
    options?: { rootDir?: string },
  ) => Promise<Wave1ReleasePlanResult & Record<string, unknown>>;
  activateWave1Release: (
    rootDir: string,
    appName: string,
    releaseId: string,
  ) => Promise<Wave1ReleaseMutationResult & Record<string, unknown>>;
  rollbackWave1Release: (
    rootDir: string,
    appName: string,
  ) => Promise<Wave1ReleaseMutationResult & Record<string, unknown>>;
};

function printReleaseUsage(): void {
  console.error(
    "Usage:\n  lifeline release plan <deploy-manifest>\n  lifeline release persist <deploy-manifest>\n  lifeline release activate <app-name> <release-id>\n  lifeline release rollback <app-name>",
  );
}

function isReleaseAction(value: string | undefined): value is ReleaseAction {
  return (
    value === "plan" ||
    value === "persist" ||
    value === "activate" ||
    value === "rollback"
  );
}

async function loadWave1ReleaseModules(): Promise<Wave1ReleaseModules> {
  const moduleUrl = new URL(
    "../../control-plane/wave1-release-engine.mjs",
    import.meta.url,
  );

  return import(moduleUrl.href) as Promise<Wave1ReleaseModules>;
}

async function loadDeployManifest(manifestPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new Error(`Could not read deploy manifest at ${manifestPath}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new Error(
      `Could not parse deploy manifest JSON at ${manifestPath}: ${message}`,
    );
  }
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function exitCodeForPlanResult(result: Wave1ReleasePlanResult): number {
  return result.validation.status === "passed" ? 0 : 1;
}

function exitCodeForMutationResult(result: Wave1ReleaseMutationResult): number {
  return result.ok ? 0 : 1;
}

export async function runReleaseCommand(args: string[]): Promise<number> {
  try {
    const [action, ...rest] = args;
    if (!action) {
      console.error(
        "Missing release action. Use one of: plan, persist, activate, rollback.",
      );
      printReleaseUsage();
      return 1;
    }

    if (!isReleaseAction(action)) {
      console.error(
        `Unknown release action: ${action}. Use one of: plan, persist, activate, rollback.`,
      );
      printReleaseUsage();
      return 1;
    }

    const modules = await loadWave1ReleaseModules();
    const rootDir = process.cwd();

    if (action === "plan" || action === "persist") {
      const manifestPath = rest[0];
      if (!manifestPath) {
        console.error("Missing deploy manifest path.");
        printReleaseUsage();
        return 1;
      }

      const manifest = await loadDeployManifest(manifestPath);
      const result =
        action === "plan"
          ? modules.planWave1Release(manifest, { rootDir })
          : await modules.persistWave1Release(manifest, { rootDir });

      printJson(result);
      return exitCodeForPlanResult(result);
    }

    if (action === "activate") {
      const appName = rest[0];
      const releaseId = rest[1];
      if (!appName || !releaseId) {
        console.error("Missing app name or release id.");
        printReleaseUsage();
        return 1;
      }

      const result = await modules.activateWave1Release(
        rootDir,
        appName,
        releaseId,
      );
      printJson(result);
      return exitCodeForMutationResult(result);
    }

    const appName = rest[0];
    if (!appName) {
      console.error("Missing app name.");
      printReleaseUsage();
      return 1;
    }

    const result = await modules.rollbackWave1Release(rootDir, appName);
    printJson(result);
    return exitCodeForMutationResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
