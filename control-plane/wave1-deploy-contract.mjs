import { createHash } from "node:crypto";
import path from "node:path";

export const WAVE1_DEPLOY_CONTRACT_VERSION = "atlas.lifeline.deploy-contract.v1";
export const WAVE1_RELEASE_METADATA_VERSION =
  "atlas.lifeline.release-metadata.v1";
export const WAVE1_DRY_RUN_PLAN_VERSION = "atlas.lifeline.deploy-dry-run.v1";
export const WAVE1_RELEASE_PLAN_VERSION = "atlas.lifeline.release-plan.v1";

export const SUPPORTED_ROLLBACK_STRATEGIES = ["redeploy", "restore"];
export const SUPPORTED_HOOK_NAMES = [
  "preDeploy",
  "postDeploy",
  "rollback",
  "preActivate",
  "postActivate",
  "preRollback",
];
export const SUPPORTED_SOURCE_ADAPTER_KINDS = [
  "artifactRef",
  "imageRef",
  "branch",
];
export const WAVE1_RELEASE_TARGET_KIND = "single-host-immutable";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function pushIssue(issues, path, message) {
  issues.push({ path, message });
}

function normalizeStringList(value) {
  return [...value];
}

function validateAppName(appName, issues) {
  if (!isNonEmptyString(appName)) {
    pushIssue(issues, "appName", "must be a non-empty string");
    return undefined;
  }

  if (path.isAbsolute(appName)) {
    pushIssue(issues, "appName", "must not be an absolute path");
  }

  if (appName.includes("/") || appName.includes("\\")) {
    pushIssue(issues, "appName", "must not contain path separators");
  }

  if (appName === "." || appName === "..") {
    pushIssue(issues, "appName", "must not equal '.' or '..'");
  }

  if (
    path.isAbsolute(appName) ||
    appName.includes("/") ||
    appName.includes("\\") ||
    appName === "." ||
    appName === ".."
  ) {
    return undefined;
  }

  return appName;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = stableJsonValue(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function buildBranchArtifactRef(repo, branch) {
  const normalizedRepo = repo.replace(/#.*$/, "");
  const prefix = normalizedRepo.startsWith("git+")
    ? normalizedRepo
    : `git+${normalizedRepo}`;
  return `${prefix}#${branch}`;
}

function validateRoute(route, issues) {
  if (!isRecord(route)) {
    pushIssue(issues, "route", "must be an object");
    return undefined;
  }

  if (!isNonEmptyString(route.domain)) {
    pushIssue(issues, "route.domain", "must be a non-empty string");
  }

  if (route.path !== undefined) {
    if (!isNonEmptyString(route.path)) {
      pushIssue(issues, "route.path", "must be a non-empty string");
    } else if (!route.path.startsWith("/")) {
      pushIssue(issues, "route.path", "must start with '/'");
    }
  }

  if (!isNonEmptyString(route.domain)) {
    return undefined;
  }

  return {
    domain: route.domain,
    ...(isNonEmptyString(route.path) ? { path: route.path } : {}),
  };
}

function validateHooks(hooks, issues) {
  if (hooks === undefined) {
    pushIssue(issues, "migrationHooks", "must be an object");
    return undefined;
  }

  if (!isRecord(hooks)) {
    pushIssue(issues, "migrationHooks", "must be an object");
    return undefined;
  }

  const normalized = {
    preDeploy: [],
    postDeploy: [],
    rollback: [],
    preActivate: [],
    postActivate: [],
    preRollback: [],
  };

  for (const hookName of SUPPORTED_HOOK_NAMES) {
    const hookValue = hooks[hookName];
    if (hookValue === undefined) {
      continue;
    }

    if (!isStringArray(hookValue)) {
      pushIssue(
        issues,
        `migrationHooks.${hookName}`,
        "must be an array of non-empty strings",
      );
      continue;
    }

    normalized[hookName] = normalizeStringList(hookValue);
  }

  return normalized;
}

function validateArtifactRef(manifest, issues) {
  const artifactRef =
    isNonEmptyString(manifest.artifactRef) ? manifest.artifactRef : undefined;
  const imageRef = isNonEmptyString(manifest.imageRef)
    ? manifest.imageRef
    : undefined;
  const repo = isNonEmptyString(manifest.repo) ? manifest.repo : undefined;
  const branch = isNonEmptyString(manifest.branch) ? manifest.branch : undefined;

  if ((repo && !branch) || (!repo && branch)) {
    pushIssue(
      issues,
      !repo ? "repo" : "branch",
      "repo and branch must be provided together",
    );
    return undefined;
  }

  if (!artifactRef && !imageRef && !(repo && branch)) {
    pushIssue(
      issues,
      "artifactRef",
      "must be provided as artifactRef, imageRef, or repo+branch",
    );
    return undefined;
  }

  if (artifactRef) {
    return {
      artifactRef,
      sourceAdapter: {
        kind: "artifactRef",
        artifactRef,
        canonicalArtifactRef: artifactRef,
      },
    };
  }

  if (imageRef) {
    return {
      artifactRef: imageRef,
      sourceAdapter: {
        kind: "imageRef",
        imageRef,
        canonicalArtifactRef: imageRef,
      },
    };
  }

  const canonicalArtifactRef = buildBranchArtifactRef(repo, branch);
  return {
    artifactRef: canonicalArtifactRef,
    sourceAdapter: {
      kind: "branch",
      repo,
      branch,
      canonicalArtifactRef,
    },
  };
}

function validateSourceAdapter(adapter, issues) {
  if (adapter === undefined) {
    return undefined;
  }

  if (!isRecord(adapter)) {
    pushIssue(issues, "sourceAdapter", "must be an object");
    return undefined;
  }

  if (
    !isNonEmptyString(adapter.kind) ||
    !SUPPORTED_SOURCE_ADAPTER_KINDS.includes(adapter.kind)
  ) {
    pushIssue(
      issues,
      "sourceAdapter.kind",
      `must be one of: ${SUPPORTED_SOURCE_ADAPTER_KINDS.join(", ")}`,
    );
  }

  if (!isNonEmptyString(adapter.canonicalArtifactRef)) {
    pushIssue(
      issues,
      "sourceAdapter.canonicalArtifactRef",
      "must be a non-empty string",
    );
  }

  if (adapter.kind === "artifactRef") {
    if (!isNonEmptyString(adapter.artifactRef)) {
      pushIssue(
        issues,
        "sourceAdapter.artifactRef",
        "must be a non-empty string",
      );
    }
  }

  if (adapter.kind === "imageRef") {
    if (!isNonEmptyString(adapter.imageRef)) {
      pushIssue(
        issues,
        "sourceAdapter.imageRef",
        "must be a non-empty string",
      );
    }
  }

  if (adapter.kind === "branch") {
    if (!isNonEmptyString(adapter.repo)) {
      pushIssue(issues, "sourceAdapter.repo", "must be a non-empty string");
    }

    if (!isNonEmptyString(adapter.branch)) {
      pushIssue(issues, "sourceAdapter.branch", "must be a non-empty string");
    }
  }

  if (
    !isNonEmptyString(adapter.kind) ||
    !SUPPORTED_SOURCE_ADAPTER_KINDS.includes(adapter.kind) ||
    !isNonEmptyString(adapter.canonicalArtifactRef)
  ) {
    return undefined;
  }

  if (adapter.kind === "artifactRef" && !isNonEmptyString(adapter.artifactRef)) {
    return undefined;
  }

  if (adapter.kind === "imageRef" && !isNonEmptyString(adapter.imageRef)) {
    return undefined;
  }

  if (
    adapter.kind === "branch" &&
    (!isNonEmptyString(adapter.repo) || !isNonEmptyString(adapter.branch))
  ) {
    return undefined;
  }

  return {
    kind: adapter.kind,
    canonicalArtifactRef: adapter.canonicalArtifactRef,
    ...(adapter.kind === "artifactRef"
      ? { artifactRef: adapter.artifactRef }
      : {}),
    ...(adapter.kind === "imageRef" ? { imageRef: adapter.imageRef } : {}),
    ...(adapter.kind === "branch"
      ? { repo: adapter.repo, branch: adapter.branch }
      : {}),
  };
}

function validateReleaseTarget(target, issues) {
  if (!isRecord(target)) {
    pushIssue(issues, "releaseTarget", "must be an object");
    return undefined;
  }

  if (target.kind !== WAVE1_RELEASE_TARGET_KIND) {
    pushIssue(
      issues,
      "releaseTarget.kind",
      `must equal ${WAVE1_RELEASE_TARGET_KIND}`,
    );
  }

  if (!isNonEmptyString(target.releaseId)) {
    pushIssue(issues, "releaseTarget.releaseId", "must be a non-empty string");
  }

  if (!isNonEmptyString(target.artifactRef)) {
    pushIssue(
      issues,
      "releaseTarget.artifactRef",
      "must be a non-empty string",
    );
  }

  if (
    target.kind !== WAVE1_RELEASE_TARGET_KIND ||
    !isNonEmptyString(target.releaseId) ||
    !isNonEmptyString(target.artifactRef)
  ) {
    return undefined;
  }

  return {
    kind: target.kind,
    releaseId: target.releaseId,
    artifactRef: target.artifactRef,
  };
}

function synthesizeReleaseTarget(value) {
  if (!isNonEmptyString(value.releaseId) || !isNonEmptyString(value.artifactRef)) {
    return undefined;
  }

  return {
    kind: WAVE1_RELEASE_TARGET_KIND,
    releaseId: value.releaseId,
    artifactRef: value.artifactRef,
  };
}

function validateRollbackTarget(target, issues) {
  if (!isRecord(target)) {
    pushIssue(issues, "rollbackTarget", "must be an object");
    return undefined;
  }

  if (!isNonEmptyString(target.releaseId)) {
    pushIssue(issues, "rollbackTarget.releaseId", "must be a non-empty string");
  }

  if (!isNonEmptyString(target.artifactRef)) {
    pushIssue(
      issues,
      "rollbackTarget.artifactRef",
      "must be a non-empty string",
    );
  }

  if (
    !isNonEmptyString(target.strategy) ||
    !SUPPORTED_ROLLBACK_STRATEGIES.includes(target.strategy)
  ) {
    pushIssue(
      issues,
      "rollbackTarget.strategy",
      `must be one of: ${SUPPORTED_ROLLBACK_STRATEGIES.join(", ")}`,
    );
  }

  if (
    !isNonEmptyString(target.releaseId) ||
    !isNonEmptyString(target.artifactRef) ||
    !SUPPORTED_ROLLBACK_STRATEGIES.includes(target.strategy)
  ) {
    return undefined;
  }

  return {
    releaseId: target.releaseId,
    artifactRef: target.artifactRef,
    strategy: target.strategy,
    ...(isNonEmptyString(target.note) ? { note: target.note } : {}),
  };
}

export function validateWave1DeployManifest(value) {
  const issues = [];

  if (!isRecord(value)) {
    return {
      issues: [{ path: "$", message: "manifest must be a JSON object" }],
    };
  }

  if (value.contractVersion !== WAVE1_DEPLOY_CONTRACT_VERSION) {
    pushIssue(
      issues,
      "contractVersion",
      `must equal ${WAVE1_DEPLOY_CONTRACT_VERSION}`,
    );
  }

  const appName = validateAppName(value.appName, issues);

  const artifactInput = validateArtifactRef(value, issues);
  const route = validateRoute(value.route, issues);
  if (value.envRefs === undefined) {
    pushIssue(issues, "envRefs", "must be an array of non-empty strings");
  }
  const envRefs = value.envRefs ?? [];

  if (!isStringArray(envRefs)) {
    pushIssue(issues, "envRefs", "must be an array of non-empty strings");
  }

  if (!isNonEmptyString(value.healthcheckPath)) {
    pushIssue(issues, "healthcheckPath", "must be a non-empty string");
  } else if (!value.healthcheckPath.startsWith("/")) {
    pushIssue(issues, "healthcheckPath", "must start with '/'");
  }

  const migrationHooks = validateHooks(value.migrationHooks, issues);
  const rollbackTarget = validateRollbackTarget(value.rollbackTarget, issues);

  if (issues.length > 0) {
    return { issues };
  }

  return {
    issues,
    manifest: {
      contractVersion: WAVE1_DEPLOY_CONTRACT_VERSION,
      appName,
      artifactRef: artifactInput.artifactRef,
      route,
      envRefs: normalizeStringList(envRefs),
      healthcheckPath: value.healthcheckPath,
      migrationHooks,
      rollbackTarget,
      ...(artifactInput.sourceAdapter
        ? { sourceAdapter: artifactInput.sourceAdapter }
        : {}),
    },
  };
}

export function validateWave1ReleaseMetadata(value) {
  const issues = [];

  if (!isRecord(value)) {
    return {
      issues: [{ path: "$", message: "release metadata must be a JSON object" }],
    };
  }

  if (value.contractVersion !== WAVE1_RELEASE_METADATA_VERSION) {
    pushIssue(
      issues,
      "contractVersion",
      `must equal ${WAVE1_RELEASE_METADATA_VERSION}`,
    );
  }

  if (!isNonEmptyString(value.releaseId)) {
    pushIssue(issues, "releaseId", "must be a non-empty string");
  }

  const appName = validateAppName(value.appName, issues);

  if (!isNonEmptyString(value.artifactRef)) {
    pushIssue(issues, "artifactRef", "must be a non-empty string");
  }

  const sourceAdapter = validateSourceAdapter(value.sourceAdapter, issues);

  const route = validateRoute(value.route, issues);

  if (!isStringArray(value.envRefs)) {
    pushIssue(issues, "envRefs", "must be an array of non-empty strings");
  }

  if (!isNonEmptyString(value.healthcheckPath)) {
    pushIssue(issues, "healthcheckPath", "must be a non-empty string");
  } else if (!value.healthcheckPath.startsWith("/")) {
    pushIssue(issues, "healthcheckPath", "must start with '/'");
  }

  const migrationHooks = validateHooks(value.migrationHooks, issues);
  const rollbackTarget = validateRollbackTarget(value.rollbackTarget, issues);
  const releaseTarget =
    value.releaseTarget === undefined
      ? synthesizeReleaseTarget(value)
      : validateReleaseTarget(value.releaseTarget, issues);

  if (
    !isRecord(value.validation) ||
    !["passed", "failed"].includes(value.validation.status)
  ) {
    pushIssue(
      issues,
      "validation.status",
      "must be one of: passed, failed",
    );
  }

  if (
    !isRecord(value.validation) ||
    !Array.isArray(value.validation.issues) ||
    value.validation.issues.some((issue) => {
      return (
        !isRecord(issue) ||
        !isNonEmptyString(issue.path) ||
        !isNonEmptyString(issue.message)
      );
    })
  ) {
    pushIssue(
      issues,
      "validation.issues",
      "must be an array of { path, message } issues",
    );
  }

  if (typeof value.dryRun !== "boolean") {
    pushIssue(issues, "dryRun", "must be a boolean");
  }

  if (!isNonEmptyString(value.createdAt)) {
    pushIssue(issues, "createdAt", "must be a non-empty string");
  }

  if (issues.length > 0) {
    return { issues };
  }

  return {
    issues,
    metadata: {
      contractVersion: WAVE1_RELEASE_METADATA_VERSION,
      releaseId: value.releaseId,
      appName,
      artifactRef: value.artifactRef,
      route,
      envRefs: normalizeStringList(value.envRefs),
      healthcheckPath: value.healthcheckPath,
      migrationHooks,
      rollbackTarget,
      ...(sourceAdapter ? { sourceAdapter } : {}),
      releaseTarget,
      dryRun: value.dryRun,
      createdAt: value.createdAt,
      validation: {
        status: value.validation.status,
        issues: value.validation.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    },
  };
}

export function deriveWave1ReleaseId(manifest) {
  const validation = validateWave1DeployManifest(manifest);
  if (validation.issues.length > 0 || !validation.manifest) {
    return undefined;
  }

  const hash = createHash("sha256")
    .update(
      stableJsonStringify({
        appName: validation.manifest.appName,
        artifactRef: validation.manifest.artifactRef,
        route: validation.manifest.route,
        envRefs: validation.manifest.envRefs,
        healthcheckPath: validation.manifest.healthcheckPath,
        migrationHooks: validation.manifest.migrationHooks,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return `release-${validation.manifest.appName}-${hash}`;
}

export function buildWave1ReleaseMetadata(manifest, options) {
  const validation = validateWave1DeployManifest(manifest);
  const releaseId = options?.releaseId ?? deriveWave1ReleaseId(manifest);
  const createdAt = options?.createdAt ?? "1970-01-01T00:00:00.000Z";
  const dryRun = options?.dryRun ?? false;

  if (
    validation.issues.length > 0 ||
    !validation.manifest ||
    !isNonEmptyString(releaseId)
  ) {
    return {
      issues: validation.issues,
      metadata: undefined,
    };
  }

  return {
    issues: [],
    metadata: {
      contractVersion: WAVE1_RELEASE_METADATA_VERSION,
      releaseId,
      appName: validation.manifest.appName,
      artifactRef: validation.manifest.artifactRef,
      route: validation.manifest.route,
      envRefs: validation.manifest.envRefs,
      healthcheckPath: validation.manifest.healthcheckPath,
      migrationHooks: validation.manifest.migrationHooks,
      rollbackTarget: validation.manifest.rollbackTarget,
      ...(validation.manifest.sourceAdapter
        ? { sourceAdapter: validation.manifest.sourceAdapter }
        : {}),
      releaseTarget: {
        kind: WAVE1_RELEASE_TARGET_KIND,
        releaseId,
        artifactRef: validation.manifest.artifactRef,
      },
      dryRun,
      createdAt,
      validation: {
        status: "passed",
        issues: [],
      },
    },
  };
}

export function buildWave1DryRunPlan(manifest, options) {
  const validation = validateWave1DeployManifest(manifest);
  const releaseId = options?.releaseId ?? deriveWave1ReleaseId(manifest);
  const createdAt = options?.createdAt ?? "1970-01-01T00:00:00.000Z";

  if (validation.issues.length > 0 || !validation.manifest) {
    return {
      contractVersion: WAVE1_DRY_RUN_PLAN_VERSION,
      releaseId,
      appName: isRecord(manifest) && isNonEmptyString(manifest.appName)
        ? manifest.appName
        : "unknown",
      steps: [
        {
          step: "validate-manifest",
          status: "failed",
          detail: "validation failed before dry-run planning",
        },
      ],
      validation: {
        status: "failed",
        issues: validation.issues,
      },
      releaseMetadata: null,
    };
  }

  const builtReleaseMetadata = buildWave1ReleaseMetadata(manifest, {
    releaseId,
    createdAt,
    dryRun: true,
  });
  const releaseMetadata = builtReleaseMetadata.metadata;

  return {
    contractVersion: WAVE1_DRY_RUN_PLAN_VERSION,
    releaseId,
    appName: validation.manifest.appName,
    steps: [
      {
        step: "validate-manifest",
        status: "passed",
        detail: "deploy manifest is valid",
      },
      {
        step: "canonicalize-artifact-ref",
        status: "passed",
        detail:
          validation.manifest.sourceAdapter?.kind === "branch"
            ? "repo+branch input canonicalized to artifactRef for persistence"
            : "artifactRef is ready for persistence",
      },
      {
        step: "prepare-release-metadata",
        status: "passed",
        detail: "release metadata preview is ready",
      },
      {
        step: "derive-release-target",
        status: "passed",
        detail: "release target is pinned to a concrete release id",
      },
      {
        step: "preserve-rollback-target",
        status: "passed",
        detail: "rollback target metadata is unchanged in dry-run mode",
      },
    ],
    validation: {
      status: "passed",
      issues: [],
    },
    releaseMetadata,
  };
}

export function buildWave1ReleasePlan(manifest, options) {
  const validation = validateWave1DeployManifest(manifest);
  const releaseId = options?.releaseId ?? deriveWave1ReleaseId(manifest);
  const createdAt = options?.createdAt ?? "1970-01-01T00:00:00.000Z";
  const builtReleaseMetadata = buildWave1ReleaseMetadata(manifest, {
    releaseId,
    createdAt,
    dryRun: false,
  });

  if (
    validation.issues.length > 0 ||
    !validation.manifest ||
    !builtReleaseMetadata.metadata
  ) {
    return {
      contractVersion: WAVE1_RELEASE_PLAN_VERSION,
      releaseId: releaseId ?? "invalid-release",
      appName:
        isRecord(manifest) && isNonEmptyString(manifest.appName)
          ? manifest.appName
          : "unknown",
      steps: [
        {
          step: "validate-manifest",
          status: "failed",
          detail: "validation failed before release planning",
        },
      ],
      validation: {
        status: "failed",
        issues: validation.issues,
      },
      releaseMetadata: null,
    };
  }

  return {
    contractVersion: WAVE1_RELEASE_PLAN_VERSION,
    releaseId,
    appName: validation.manifest.appName,
    steps: [
      {
        step: "validate-manifest",
        status: "passed",
        detail: "deploy manifest is valid",
      },
      {
        step: "canonicalize-artifact-ref",
        status: "passed",
        detail:
          validation.manifest.sourceAdapter?.kind === "branch"
            ? "repo+branch input canonicalized to artifactRef for persistence"
            : "artifactRef is ready for immutable release staging",
      },
      {
        step: "derive-release-id",
        status: "passed",
        detail: "release id is deterministic for the normalized release target",
      },
      {
        step: "derive-release-target",
        status: "passed",
        detail: "release target is pinned to a concrete immutable release id",
      },
      {
        step: "preserve-rollback-target",
        status: "passed",
        detail: "rollback target metadata is preserved for activation and rollback",
      },
    ],
    validation: {
      status: "passed",
      issues: [],
    },
    releaseMetadata: builtReleaseMetadata.metadata,
  };
}

export function serializeWave1ReleaseMetadata(metadata) {
  return JSON.stringify(metadata, null, 2);
}

export function parseWave1ReleaseMetadata(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      issues: [
        {
          path: "$",
          message:
            error instanceof Error ? error.message : "could not parse JSON",
        },
      ],
    };
  }

  return validateWave1ReleaseMetadata(parsed);
}
