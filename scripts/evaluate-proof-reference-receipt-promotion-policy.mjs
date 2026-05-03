import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProofReferenceReceiptCandidate } from "./write-proof-reference-receipt.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasApprovalNote(candidate) {
  return isNonEmptyString(candidate?.approval?.approval_note);
}

function hasReviewerIdentity(candidate) {
  return (
    isNonEmptyString(candidate?.approval?.reviewer_id) ||
    isNonEmptyString(candidate?.approval?.reviewer_label)
  );
}

function hasOwnerBoundaryStatement(candidate) {
  return isNonEmptyString(candidate?.boundary?.statement);
}

function preservesOwnerBoundary(candidate) {
  if (!hasOwnerBoundaryStatement(candidate)) {
    return false;
  }

  const normalized = candidate.boundary.statement.toLowerCase();
  return (
    normalized.includes("cortex") &&
    normalized.includes("lifeline") &&
    normalized.includes("final receipt truth")
  );
}

function isExplicitPromotionIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isSafePromotionIdentifier(value) {
  return (
    isExplicitPromotionIdentifier(value) &&
    /^[A-Za-z0-9._:-]+$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function collectPromotionIdentifiers(candidate) {
  return [
    ["source_repo_id", candidate?.source_repo_id],
    ["tranche_id", candidate?.tranche_id],
    ["receipt_id", candidate?.receipt_id],
  ];
}

function collectAmbiguousPromotionIdentifiers(candidate) {
  return collectPromotionIdentifiers(candidate)
    .filter(([, value]) => !isExplicitPromotionIdentifier(value))
    .map(([field]) => field);
}

function collectUnsafeDestinationSegments(candidate) {
  return collectPromotionIdentifiers(candidate)
    .filter(([, value]) => !isSafePromotionIdentifier(value))
    .map(([field]) => field);
}

function buildBlocker(code, detail) {
  return { code, detail };
}

function pushBlocker(blockers, code, detail) {
  blockers.push(buildBlocker(code, detail));
}

export async function evaluateProofReferenceReceiptPromotionPolicy({
  candidate,
  sourceCandidatePath,
  productionPromotionRequested = false,
  dryRunTestReceiptPassed = false,
  evidenceOrigin = "proof_reference_pack",
  stableProofReference = true,
  schemaPath = path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
}) {
  const validation = await validateProofReferenceReceiptCandidate({
    candidate,
    schemaPath,
  });

  const blockers = [];
  const ambiguousIdentifiers = collectAmbiguousPromotionIdentifiers(candidate);
  const unsafeDestinationSegments = collectUnsafeDestinationSegments(candidate);
  const ownerBoundaryValid = preservesOwnerBoundary(candidate);
  const sourceRepoConsistent =
    typeof candidate?.source_repo_id === "string" &&
    candidate?.proof_summary?.owner_repo_id === candidate.source_repo_id;

  const checks = {
    schema_valid: validation.schemaValid,
    explicit_human_approval: candidate?.approval?.explicit_human_approval === true,
    auto_approved_false: candidate?.approval?.auto_approved === false,
    human_approval_metadata_present: hasReviewerIdentity(candidate) && hasApprovalNote(candidate),
    current_validation_debt_empty:
      Array.isArray(candidate?.validation_context?.current_validation_debt) &&
      candidate.validation_context.current_validation_debt.length === 0,
    proof_references_complete: validation.missingRequiredProofRefs.length === 0,
    proof_references_canonical: validation.canonicalRefErrors.length === 0,
    owner_boundary_valid: ownerBoundaryValid,
    source_repo_consistent: sourceRepoConsistent,
    promotion_identifiers_explicit: ambiguousIdentifiers.length === 0,
    destination_segments_safe: unsafeDestinationSegments.length === 0,
    source_candidate_path_explicit: isNonEmptyString(sourceCandidatePath),
    production_promotion_requested: productionPromotionRequested === true,
    dry_run_test_receipt_passed: dryRunTestReceiptPassed === true,
    stable_proof_reference:
      evidenceOrigin !== "connector" || stableProofReference === true,
  };

  if (!checks.schema_valid) {
    pushBlocker(
      blockers,
      "schema_validation_failed",
      validation.schemaErrors.join(" "),
    );
  }
  if (!checks.explicit_human_approval) {
    pushBlocker(
      blockers,
      "missing_explicit_human_approval",
      "Promotion requires explicit human approval in the candidate payload.",
    );
  }
  if (!checks.auto_approved_false) {
    pushBlocker(
      blockers,
      "auto_approval_forbidden",
      "Promotion is forbidden when approval.auto_approved is true.",
    );
  }
  if (!checks.human_approval_metadata_present) {
    pushBlocker(
      blockers,
      "missing_human_approval_metadata",
      "Promotion requires reviewer identity and a non-empty approval note.",
    );
  }
  if (!checks.current_validation_debt_empty) {
    pushBlocker(
      blockers,
      "current_validation_debt_present",
      "Promotion requires current_validation_debt to be empty.",
    );
  }
  if (!checks.proof_references_complete) {
    pushBlocker(
      blockers,
      "missing_required_proof_refs",
      `Promotion requires all proof-reference inputs in source_refs. Missing: ${validation.missingRequiredProofRefs.join(", ")}.`,
    );
  }
  if (!checks.proof_references_canonical) {
    pushBlocker(
      blockers,
      "noncanonical_ref",
      validation.canonicalRefErrors.join(" "),
    );
  }
  if (!checks.owner_boundary_valid) {
    pushBlocker(
      blockers,
      "invalid_owner_boundary_statement",
      "Promotion requires an owner-boundary statement that preserves Cortex preparation and Lifeline final receipt truth.",
    );
  }
  if (!checks.source_repo_consistent) {
    pushBlocker(
      blockers,
      "source_repo_mismatch",
      "Promotion requires proof_summary.owner_repo_id to match source_repo_id.",
    );
  }
  if (!checks.promotion_identifiers_explicit) {
    pushBlocker(
      blockers,
      "ambiguous_promotion_identifiers",
      `Promotion requires explicit source_repo_id, tranche_id, and receipt_id. Ambiguous: ${ambiguousIdentifiers.join(", ")}.`,
    );
  }
  if (!checks.destination_segments_safe) {
    pushBlocker(
      blockers,
      "unsafe_receipt_destination",
      `Promotion requires safe receipt destination segments. Unsafe: ${unsafeDestinationSegments.join(", ")}.`,
    );
  }
  if (!checks.source_candidate_path_explicit) {
    pushBlocker(
      blockers,
      "source_candidate_path_missing",
      "Promotion requires an explicit source candidate path.",
    );
  }
  if (!checks.production_promotion_requested) {
    pushBlocker(
      blockers,
      "production_promotion_not_requested",
      "Promotion requires an explicit production-promotion request.",
    );
  }
  if (!checks.dry_run_test_receipt_passed) {
    pushBlocker(
      blockers,
      "isolated_roundtrip_not_confirmed",
      "Promotion requires a previously passing isolated dry-run or test receipt.",
    );
  }
  if (!checks.stable_proof_reference) {
    pushBlocker(
      blockers,
      "connector_evidence_without_stable_proof_reference",
      "Connector-derived evidence must carry a stable proof reference before promotion is eligible.",
    );
  }

  return {
    decision: blockers.length === 0 ? "promotion_permitted" : "promotion_blocked",
    promotion_eligible: blockers.length === 0,
    source_candidate_path: isNonEmptyString(sourceCandidatePath)
      ? normalizePath(path.resolve(sourceCandidatePath))
      : null,
    evidence_origin: evidenceOrigin,
    blocker_codes: blockers.map((entry) => entry.code),
    blockers,
    checks,
    validation: {
      schema_path: normalizePath(path.resolve(validation.schemaPath)),
      schema_valid: validation.schemaValid,
      schema_errors: validation.schemaErrors,
      canonical_ref_errors: validation.canonicalRefErrors,
      missing_required_proof_refs: validation.missingRequiredProofRefs,
      candidate_blocked_reason: validation.blockedReason,
    },
  };
}
