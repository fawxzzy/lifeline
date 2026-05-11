import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildWave1ReleaseMetadata,
  buildWave1ReleasePlan,
  buildWave1DryRunPlan,
  deriveWave1ReleaseId,
  parseWave1ReleaseMetadata,
  serializeWave1ReleaseMetadata,
  validateWave1DeployManifest,
  validateWave1ReleaseMetadata,
  WAVE1_DEPLOY_CONTRACT_VERSION,
  WAVE1_DRY_RUN_PLAN_VERSION,
  WAVE1_RELEASE_METADATA_VERSION,
} from "../../control-plane/wave1-deploy-contract.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixturePath = path.join(
  repoRoot,
  "control-plane/fixtures/wave1-pilot-deploy.manifest.json",
);
const deploySchemaPath = path.join(
  repoRoot,
  "schemas/wave1-deploy-contract.schema.json",
);
const metadataSchemaPath = path.join(
  repoRoot,
  "schemas/wave1-release-metadata.schema.json",
);
const docsPath = path.join(
  repoRoot,
  "docs/contracts/wave1-deploy-contract.md",
);

function readJson(filePath) {
  return readFile(filePath, "utf8").then((content) => JSON.parse(content));
}

const sampleManifest = await readJson(fixturePath);
const deploySchema = await readJson(deploySchemaPath);
const metadataSchema = await readJson(metadataSchemaPath);
const docs = await readFile(docsPath, "utf8");

const originalManifestSnapshot = JSON.stringify(sampleManifest);
const validation = validateWave1DeployManifest(sampleManifest);

assert.equal(validation.issues.length, 0, `unexpected deploy issues: ${JSON.stringify(validation.issues, null, 2)}`);
assert.equal(validation.manifest?.contractVersion, WAVE1_DEPLOY_CONTRACT_VERSION);
assert.equal(validation.manifest?.artifactRef, sampleManifest.imageRef);
assert.equal(validation.manifest?.sourceAdapter?.kind, "imageRef");
assert.equal(JSON.stringify(sampleManifest), originalManifestSnapshot, "dry-run validation must not mutate the input manifest");

const dryRunPlan = buildWave1DryRunPlan(sampleManifest, {
  releaseId: "release-20260421-0002",
  createdAt: "2026-04-21T12:00:00.000Z",
});

assert.equal(dryRunPlan.contractVersion, WAVE1_DRY_RUN_PLAN_VERSION);
assert.equal(dryRunPlan.validation.status, "passed");
assert.deepEqual(
  dryRunPlan.steps.map((step) => step.step),
  [
    "validate-manifest",
    "canonicalize-artifact-ref",
    "prepare-release-metadata",
    "derive-release-target",
    "preserve-rollback-target",
  ],
);
assert.equal(dryRunPlan.releaseMetadata?.contractVersion, WAVE1_RELEASE_METADATA_VERSION);
assert.equal(dryRunPlan.releaseMetadata?.artifactRef, sampleManifest.imageRef);
assert.equal(dryRunPlan.releaseMetadata?.dryRun, true);
assert.equal(dryRunPlan.releaseMetadata?.sourceAdapter?.kind, "imageRef");
assert.deepEqual(dryRunPlan.releaseMetadata?.releaseTarget, {
  kind: "single-host-immutable",
  releaseId: "release-20260421-0002",
  artifactRef: sampleManifest.imageRef,
});

const roundTripped = parseWave1ReleaseMetadata(
  serializeWave1ReleaseMetadata(dryRunPlan.releaseMetadata),
);
assert.equal(roundTripped.issues.length, 0, `unexpected release metadata issues: ${JSON.stringify(roundTripped.issues, null, 2)}`);
assert.deepEqual(roundTripped.metadata, dryRunPlan.releaseMetadata);

const legacyV1Metadata = {
  ...dryRunPlan.releaseMetadata,
};
delete legacyV1Metadata.releaseTarget;

const roundTrippedLegacy = parseWave1ReleaseMetadata(
  JSON.stringify(legacyV1Metadata, null, 2),
);
assert.equal(
  roundTrippedLegacy.issues.length,
  0,
  `unexpected legacy release metadata issues: ${JSON.stringify(roundTrippedLegacy.issues, null, 2)}`,
);
assert.deepEqual(roundTrippedLegacy.metadata?.releaseTarget, {
  kind: "single-host-immutable",
  releaseId: "release-20260421-0002",
  artifactRef: sampleManifest.imageRef,
});

const deterministicReleaseId = deriveWave1ReleaseId(sampleManifest);
assert.equal(
  deterministicReleaseId,
  deriveWave1ReleaseId(sampleManifest),
  "release ids must be deterministic for identical normalized manifests",
);
assert.ok(
  deterministicReleaseId?.startsWith("release-lifeline-pilot-"),
  `expected deterministic release id prefix, got ${deterministicReleaseId}`,
);

const branchShapedManifest = {
  contractVersion: WAVE1_DEPLOY_CONTRACT_VERSION,
  appName: "trove",
  repo: "https://github.com/fawxzzy/fawxzzy-trove.git",
  branch: "codex/trove-one-page-cleanup",
  route: {
    domain: "trove.fawxzzy.com",
    path: "/",
  },
  envRefs: [],
  healthcheckPath: "/healthz.json",
  migrationHooks: {
    preDeploy: ["npm run verify"],
    postDeploy: ["npm run smoke:lifeline"],
    rollback: ["lifeline down trove"],
  },
  rollbackTarget: {
    releaseId: "pre-w4-a9c347b",
    artifactRef:
      "git+https://github.com/fawxzzy/fawxzzy-trove.git#a9c347b5bc510503691478aa680e34cfa9ab81a7",
    strategy: "restore",
  },
};
const branchValidation = validateWave1DeployManifest(branchShapedManifest);
assert.equal(branchValidation.issues.length, 0, `unexpected branch-shaped issues: ${JSON.stringify(branchValidation.issues, null, 2)}`);
assert.equal(
  branchValidation.manifest?.artifactRef,
  "git+https://github.com/fawxzzy/fawxzzy-trove.git#codex/trove-one-page-cleanup",
);
assert.deepEqual(branchValidation.manifest?.sourceAdapter, {
  kind: "branch",
  repo: "https://github.com/fawxzzy/fawxzzy-trove.git",
  branch: "codex/trove-one-page-cleanup",
  canonicalArtifactRef:
    "git+https://github.com/fawxzzy/fawxzzy-trove.git#codex/trove-one-page-cleanup",
});

const branchReleaseMetadata = buildWave1ReleaseMetadata(branchShapedManifest, {
  releaseId: "release-trove-branch-adapter",
  createdAt: "2026-04-25T18:00:00.000Z",
});
assert.equal(branchReleaseMetadata.issues.length, 0);
assert.equal(
  branchReleaseMetadata.metadata?.releaseTarget.releaseId,
  "release-trove-branch-adapter",
);
assert.equal(branchReleaseMetadata.metadata?.sourceAdapter?.kind, "branch");

const releasePlan = buildWave1ReleasePlan(branchShapedManifest, {
  createdAt: "2026-04-25T18:00:00.000Z",
});
assert.equal(releasePlan.validation.status, "passed");
assert.deepEqual(
  releasePlan.steps.map((step) => step.step),
  [
    "validate-manifest",
    "canonicalize-artifact-ref",
    "derive-release-id",
    "derive-release-target",
    "preserve-rollback-target",
  ],
);
assert.equal(
  releasePlan.releaseMetadata?.releaseTarget.artifactRef,
  branchValidation.manifest?.artifactRef,
);

const invalidManifest = validateWave1DeployManifest({
  ...sampleManifest,
  healthcheckPath: "health",
  rollbackTarget: {
    ...sampleManifest.rollbackTarget,
    strategy: "rollback-now",
  },
});

assert.deepEqual(invalidManifest.issues, [
  { path: "healthcheckPath", message: "must start with '/'" },
  {
    path: "rollbackTarget.strategy",
    message: "must be one of: redeploy, restore",
  },
]);

const invalidAppNames = [
  { appName: "../escaped-app", expectedMessage: "must not contain path separators" },
  { appName: "..\\escaped-app", expectedMessage: "must not contain path separators" },
  { appName: ".", expectedMessage: "must not equal '.' or '..'" },
  { appName: "..", expectedMessage: "must not equal '.' or '..'" },
  { appName: "   ", expectedMessage: "must be a non-empty string" },
];

for (const { appName, expectedMessage } of invalidAppNames) {
  const invalidAppManifest = validateWave1DeployManifest({
    ...sampleManifest,
    appName,
  });
  assert(
    invalidAppManifest.issues.some((issue) => (
      issue.path === "appName" && issue.message === expectedMessage
    )),
    `expected appName validation issue for manifest appName=${JSON.stringify(appName)}, got ${JSON.stringify(invalidAppManifest.issues)}`,
  );

  const invalidAppMetadata = validateWave1ReleaseMetadata({
    ...dryRunPlan.releaseMetadata,
    appName,
  });
  assert(
    invalidAppMetadata.issues.some((issue) => (
      issue.path === "appName" && issue.message === expectedMessage
    )),
    `expected appName validation issue for metadata appName=${JSON.stringify(appName)}, got ${JSON.stringify(invalidAppMetadata.issues)}`,
  );
}

const invalidMetadata = validateWave1ReleaseMetadata({
  ...dryRunPlan.releaseMetadata,
  validation: {
    status: "pending",
    issues: [],
  },
});

assert(invalidMetadata.issues.some((issue) => issue.path === "validation.status"));

assert.equal(
  deploySchema.properties.contractVersion.const,
  WAVE1_DEPLOY_CONTRACT_VERSION,
);
assert.equal(
  metadataSchema.properties.contractVersion.const,
  WAVE1_RELEASE_METADATA_VERSION,
);
assert.equal(
  deploySchema.properties.rollbackTarget.properties.strategy.enum.join(","),
  "redeploy,restore",
);
assert.deepEqual(
  deploySchema.properties.appName,
  metadataSchema.properties.appName,
  "deploy and metadata schemas should enforce the same appName boundary",
);
assert.ok(
  deploySchema.properties.appName.allOf.some((rule) => rule.pattern === ".*\\S.*") &&
    deploySchema.properties.appName.allOf.some((rule) => rule.pattern === "^[^/\\\\]+$"),
  "deploy contract schema should reject whitespace-only and separator-bearing app names",
);
assert.deepEqual(
  deploySchema.properties.appName.allOf.find((rule) => rule.not)?.not.enum,
  [".", ".."],
  "deploy contract schema should reject '.' and '..' app names",
);
assert.ok(
  docs.includes("artifactRef") &&
    docs.includes("imageRef") &&
    docs.includes("repo") &&
    docs.includes("branch") &&
    docs.includes("releaseTarget") &&
    docs.includes("rollbackTarget.strategy") &&
    docs.includes("Filesystem-bound identifiers must fail at contract intake") &&
    docs.includes("Validate path-segment safety at both schema/contract boundaries and execution boundaries") &&
    docs.includes("Engine-only validation lets invalid manifests appear valid during planning or external tooling integration"),
  "docs/contracts/wave1-deploy-contract.md should describe the canonical deploy and metadata fields",
);

console.log("Wave 1 deploy contract deterministic checks passed");
