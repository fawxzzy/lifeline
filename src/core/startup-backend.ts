import { createAixInittabBackend } from "./startup-backends/aix-inittab.js";
import { createFreebsdRcDBackend } from "./startup-backends/freebsd-rcd.js";
import { createLaunchdBackend } from "./startup-backends/launchd.js";
import { createNetbsdRcDBackend } from "./startup-backends/netbsd-rcd.js";
import { createOpenbsdRcctlBackend } from "./startup-backends/openbsd-rcctl.js";
import { createSystemdUserBackend } from "./startup-backends/systemd.js";
import { createWindowsTaskSchedulerBackend } from "./startup-backends/windows-task-scheduler.js";

export type StartupBackendStatus =
  | "installed"
  | "not-installed"
  | "unsupported";
export type RuntimePlatform = string;
export type StartupBackendCapability = "inspect" | "install" | "uninstall";

export interface StartupBackendInspection {
  supported: boolean;
  status: StartupBackendStatus;
  mechanism: string;
  detail: string;
}

export interface StartupBackendRequest {
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  dryRun: boolean;
}

export interface StartupBackendResult {
  status: StartupBackendStatus;
  detail: string;
  ok?: boolean;
}

export interface StartupBackend {
  id: string;
  capabilities: StartupBackendCapability[];
  inspect(): Promise<StartupBackendInspection>;
  install(request: StartupBackendRequest): Promise<StartupBackendResult>;
  uninstall(request: StartupBackendRequest): Promise<StartupBackendResult>;
}

type StartupBackendFactory = () => StartupBackend;

export interface StartupBackendRegistry {
  byPlatform: Partial<Record<RuntimePlatform, StartupBackendFactory>>;
}

export const DEFAULT_STARTUP_BACKEND_REGISTRY: StartupBackendRegistry = {
  byPlatform: {
    aix: () => createAixInittabBackend(),
    darwin: () => createLaunchdBackend(),
    freebsd: () => createFreebsdRcDBackend(),
    linux: () => createSystemdUserBackend(),
    netbsd: () => createNetbsdRcDBackend(),
    openbsd: () => createOpenbsdRcctlBackend(),
    win32: () => createWindowsTaskSchedulerBackend(),
  },
};

function createUnsupportedBackend(platform: RuntimePlatform): StartupBackend {
  const detail = `No startup installer backend is available on ${platform} yet.`;
  const contractFallbackDetail =
    "Falling back to contract-only startup behavior.";

  return {
    id: "unsupported",
    capabilities: ["inspect"],
    inspect: async () => ({
      supported: false,
      status: "unsupported",
      mechanism: "contract-only",
      detail,
    }),
    install: async (request) => ({
      status: "unsupported",
      detail: request.dryRun
        ? `${detail} ${contractFallbackDetail} Dry-run only reports the contract plan.`
        : `${detail} ${contractFallbackDetail} Intent can still be recorded for future backend availability.`,
    }),
    uninstall: async (request) => ({
      status: "unsupported",
      detail: request.dryRun
        ? `${detail} ${contractFallbackDetail} Dry-run only reports the contract plan.`
        : `${detail} ${contractFallbackDetail} There is nothing platform-specific to remove right now.`,
    }),
  };
}

export interface StartupBackendResolutionOptions {
  backend?: StartupBackend;
  platform?: RuntimePlatform;
  registry?: StartupBackendRegistry;
}

export function resolveStartupBackend(
  options: StartupBackendResolutionOptions = {},
): StartupBackend {
  if (options.backend) {
    return options.backend;
  }

  const platform = options.platform ?? process.platform;
  const registry = options.registry ?? DEFAULT_STARTUP_BACKEND_REGISTRY;
  const backendFactory = registry.byPlatform[platform];
  if (backendFactory) {
    return backendFactory();
  }

  return createUnsupportedBackend(platform);
}
