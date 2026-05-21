import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseWave1ReleaseReceipt,
  validateWave1ReleaseReceipt,
  WAVE1_RELEASE_RECEIPT_VERSION,
} from "../../control-plane/wave1-release-engine.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const receiptSchemaPath = path.join(
  repoRoot,
  "schemas/wave1-release-receipt.schema.json",
);
const docsPath = path.join(
  repoRoot,
  "docs/contracts/wave1-release-receipt.md",
);

function buildBaseReceipt(overrides = {}) {
  return {
    contractVersion: WAVE1_RELEASE_RECEIPT_VERSION,
    receiptId: "receipt-0001",
    action: "planned",
    status: "planned",
    appName: "lifeline-pilot",
    releaseId: "release-20260511-0001",
    createdAt: "2026-05-11T18:15:00.000Z",
    releaseDirectory: ".lifeline/releases/lifeline-pilot/release-20260511-0001",
    releaseMetadataPath:
      ".lifeline/releases/lifeline-pilot/release-20260511-0001/metadata.json",
    currentPointerPath: ".lifeline/releases/lifeline-pilot/current.json",
    previousPointerPath: ".lifeline/releases/lifeline-pilot/previous.json",
    releaseTarget: {
      kind: "single-host-immutable",
      releaseId: "release-20260511-0001",
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    rollbackTarget: {
      releaseId: "release-20260510-0007",
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      strategy: "restore",
    },
    ...overrides,
  };
}

function buildPhaseEvidence(phaseName, status = "succeeded") {
  return {
    [phaseName]: {
      phase: phaseName,
      status,
      commands: [
        {
          command: `node hook-runner.mjs ${phaseName}`,
          status,
          exitCode: status === "succeeded" ? 0 : 1,
        },
      ],
    },
  };
}

const receiptSchema = JSON.parse(await readFile(receiptSchemaPath, "utf8"));
const docs = await readFile(docsPath, "utf8");

const plannedReceipt = buildBaseReceipt({
  sourceAdapter: {
    kind: "imageRef",
    imageRef:
      "ghcr.io/fawxzzy/lifeline-pilot@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    canonicalArtifactRef:
      "ghcr.io/fawxzzy/lifeline-pilot@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  },
});
assert.equal(validateWave1ReleaseReceipt(plannedReceipt).issues.length, 0);

const activateSuccessReceipt = buildBaseReceipt({
  receiptId: "receipt-activate-success",
  action: "activate",
  status: "succeeded",
  previousReleaseId: "release-20260510-0007",
  health: {
    ok: true,
    status: 200,
  },
  phaseEvidence: {
    ...buildPhaseEvidence("preActivate"),
    ...buildPhaseEvidence("postActivate"),
  },
  lineage: {
    promotedFromReleaseId: "release-20260510-0007",
    promotedToReleaseId: "release-20260511-0001",
  },
});
assert.equal(validateWave1ReleaseReceipt(activateSuccessReceipt).issues.length, 0);

const activateFailureReceipt = buildBaseReceipt({
  receiptId: "receipt-activate-failed",
  action: "activate",
  status: "failed",
  previousReleaseId: "release-20260510-0007",
  failedPhase: "healthcheck",
  health: {
    ok: false,
    status: 503,
    error: "health gate rejected candidate",
  },
  phaseEvidence: buildPhaseEvidence("preActivate"),
  preservedCurrentReleaseId: "release-20260510-0007",
});
assert.equal(validateWave1ReleaseReceipt(activateFailureReceipt).issues.length, 0);

const rollbackSuccessReceipt = buildBaseReceipt({
  receiptId: "receipt-rollback-success",
  action: "rollback",
  status: "succeeded",
  previousReleaseId: "release-20260511-0001",
  health: {
    ok: true,
    status: 200,
  },
  phaseEvidence: buildPhaseEvidence("preRollback"),
  lineage: {
    promotedFromReleaseId: "release-20260511-0001",
    promotedToReleaseId: "release-20260510-0007",
  },
});
assert.equal(validateWave1ReleaseReceipt(rollbackSuccessReceipt).issues.length, 0);

const rollbackFailureReceipt = buildBaseReceipt({
  receiptId: "receipt-rollback-failed",
  action: "rollback",
  status: "failed",
  previousReleaseId: "release-20260511-0001",
  failedPhase: "preRollback",
  phaseEvidence: buildPhaseEvidence("preRollback", "failed"),
  preservedCurrentReleaseId: "release-20260511-0001",
  preservedPreviousReleaseId: "release-20260510-0007",
});
assert.equal(validateWave1ReleaseReceipt(rollbackFailureReceipt).issues.length, 0);

const missingFailedPhase = validateWave1ReleaseReceipt({
  ...activateFailureReceipt,
  failedPhase: undefined,
});
assert(
  missingFailedPhase.issues.some((issue) => issue.path === "failedPhase"),
  `expected failedPhase issue, got ${JSON.stringify(missingFailedPhase.issues)}`,
);

const missingPhaseEvidence = validateWave1ReleaseReceipt({
  ...rollbackFailureReceipt,
  phaseEvidence: undefined,
});
assert(
  missingPhaseEvidence.issues.some((issue) => issue.path === "phaseEvidence"),
  `expected phaseEvidence issue, got ${JSON.stringify(missingPhaseEvidence.issues)}`,
);

const roundTrip = parseWave1ReleaseReceipt(JSON.stringify(activateSuccessReceipt, null, 2));
assert.equal(roundTrip.issues.length, 0);
assert.deepEqual(roundTrip.receipt, activateSuccessReceipt);

assert.equal(
  receiptSchema.properties.contractVersion.const,
  WAVE1_RELEASE_RECEIPT_VERSION,
);
assert.deepEqual(receiptSchema.properties.action.enum, [
  "planned",
  "activate",
  "rollback",
]);
assert.deepEqual(receiptSchema.properties.status.enum, [
  "planned",
  "succeeded",
  "failed",
]);
assert.ok(
  receiptSchema.allOf.some((rule) =>
    rule.then?.required?.includes("phaseEvidence") &&
    rule.then?.required?.includes("failedPhase")),
  "release receipt schema should require phaseEvidence and failedPhase for failure flows",
);
assert.ok(
  docs.includes("atlas.lifeline.release-receipt.v1") &&
    docs.includes("action=planned") &&
    docs.includes("action=activate") &&
    docs.includes("action=rollback") &&
    docs.includes("failedPhase") &&
    docs.includes("phaseEvidence") &&
    docs.includes("Operator evidence must be schema-backed and deterministic before it is written to disk") &&
    docs.includes("Validate release receipts at emission time and verify the emitted receipts deterministically across success and failure paths"),
  "release receipt contract doc should describe the receipt variants and operator evidence rule",
);

console.log("Wave 1 release receipt contract deterministic checks passed");
