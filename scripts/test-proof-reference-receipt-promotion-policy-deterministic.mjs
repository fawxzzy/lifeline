import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateProofReferenceReceiptPromotionPolicy } from "./evaluate-proof-reference-receipt-promotion-policy.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = path.join(
  repoRoot,
  "fixtures",
  "contracts",
  "proof-reference-receipt.example.json",
);
const policyDocPath = path.join(
  repoRoot,
  "docs",
  "contracts",
  "proof-reference-receipt-promotion-policy.md",
);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function withOverrides(base, overrides) {
  const candidate = cloneJson(base);

  if (overrides.contract_version !== undefined) {
    candidate.contract_version = overrides.contract_version;
  }
  if (overrides.receipt_id !== undefined) {
    candidate.receipt_id = overrides.receipt_id;
  }
  if (overrides.source_repo_id !== undefined) {
    candidate.source_repo_id = overrides.source_repo_id;
  }
  if (overrides.tranche_id !== undefined) {
    candidate.tranche_id = overrides.tranche_id;
  }
  if (overrides.source_artifacts) {
    candidate.source_artifacts = {
      ...candidate.source_artifacts,
      ...overrides.source_artifacts,
    };
  }
  if (overrides.approval) {
    candidate.approval = {
      ...candidate.approval,
      ...overrides.approval,
    };
  }
  if (overrides.boundary) {
    candidate.boundary = {
      ...candidate.boundary,
      ...overrides.boundary,
    };
  }
  if (overrides.proof_summary) {
    candidate.proof_summary = {
      ...candidate.proof_summary,
      ...overrides.proof_summary,
    };
  }
  if (overrides.proof_refs) {
    candidate.proof_refs = {
      ...candidate.proof_refs,
      ...overrides.proof_refs,
    };
  }
  if (overrides.source_refs) {
    candidate.source_refs = overrides.source_refs;
  }
  if (overrides.validation_context) {
    candidate.validation_context = {
      ...candidate.validation_context,
      ...overrides.validation_context,
    };
  }

  return candidate;
}

function assertBlocked(result, code) {
  assert.equal(result.promotion_eligible, false);
  assert.equal(result.decision, "promotion_blocked");
  assert(result.blocker_codes.includes(code), `expected blocker ${code}`);
}

const [fixture, policyDoc] = await Promise.all([
  readFile(fixturePath, "utf8").then((content) => JSON.parse(content)),
  readFile(policyDocPath, "utf8"),
]);

assert(
  policyDoc.includes("A Lifeline receipt may only be promoted from isolated proof to production receipt") &&
    policyDoc.includes("Roundtrip proof validates mechanics; promotion policy governs production eligibility.") &&
    policyDoc.includes("Do not treat a passing isolated roundtrip as permission to write production receipts automatically."),
  "promotion policy doc should include the Rule, Pattern, and Failure Mode summary",
);

const explicitCandidatePath = path.join(
  repoRoot,
  "runtime",
  "cortex",
  "lifeline-receipt-candidates",
  "runs",
  "proof-reference-accepted-f11.json",
);

const allowed = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: cloneJson(fixture),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assert.equal(allowed.promotion_eligible, true);
assert.equal(allowed.decision, "promotion_permitted");
assert.deepEqual(allowed.blockers, []);
assert.equal(
  allowed.source_candidate_path,
  normalizePath(path.resolve(explicitCandidatePath)),
);
assert.equal(allowed.checks.production_promotion_requested, true);
assert.equal(allowed.checks.dry_run_test_receipt_passed, true);
assert.equal(allowed.checks.destination_segments_safe, true);

const missingApproval = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    approval: {
      explicit_human_approval: false,
    },
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(missingApproval, "missing_explicit_human_approval");

const autoApproved = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    approval: {
      auto_approved: true,
    },
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(autoApproved, "auto_approval_forbidden");

const currentDebt = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    validation_context: {
      current_validation_debt: ["observed critical=345, error=14, warning=183"],
    },
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(currentDebt, "current_validation_debt_present");

const schemaFailure = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    contract_version: "atlas.lifeline.proof-reference.receipt.v0",
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(schemaFailure, "schema_validation_failed");

const nonCanonicalRef = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    proof_refs: {
      visual_report_ref: "runtime\\atlas\\ui-visual-proof\\fitness\\latest.json",
    },
    source_refs: [
      fixture.source_artifacts.proof_reference_pack_ref,
      fixture.source_artifacts.write_ready_artifact_ref,
      fixture.proof_summary.summary_ref,
      fixture.proof_refs.semantic_report_ref,
      "runtime\\atlas\\ui-visual-proof\\fitness\\latest.json",
    ],
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(nonCanonicalRef, "noncanonical_ref");

const unsafeDestination = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    source_repo_id: "../escape",
    proof_summary: {
      owner_repo_id: "../escape",
    },
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(unsafeDestination, "unsafe_receipt_destination");

const ambiguousIdentifiers = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: withOverrides(fixture, {
    tranche_id: "  ",
  }),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(ambiguousIdentifiers, "ambiguous_promotion_identifiers");

const noSourceCandidatePath = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: cloneJson(fixture),
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: true,
});
assertBlocked(noSourceCandidatePath, "source_candidate_path_missing");

const noProductionIntent = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: cloneJson(fixture),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: false,
  dryRunTestReceiptPassed: true,
});
assertBlocked(noProductionIntent, "production_promotion_not_requested");

const noDryRun = await evaluateProofReferenceReceiptPromotionPolicy({
  candidate: cloneJson(fixture),
  sourceCandidatePath: explicitCandidatePath,
  productionPromotionRequested: true,
  dryRunTestReceiptPassed: false,
});
assertBlocked(noDryRun, "isolated_roundtrip_not_confirmed");

const connectorWithoutStableProofReference =
  await evaluateProofReferenceReceiptPromotionPolicy({
    candidate: cloneJson(fixture),
    sourceCandidatePath: explicitCandidatePath,
    productionPromotionRequested: true,
    dryRunTestReceiptPassed: true,
    evidenceOrigin: "connector",
    stableProofReference: false,
  });
assertBlocked(
  connectorWithoutStableProofReference,
  "connector_evidence_without_stable_proof_reference",
);

console.log("Proof-reference receipt promotion policy deterministic checks passed");
