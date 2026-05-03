import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { evaluateProofReferenceReceiptPromotionPolicy } from "./evaluate-proof-reference-receipt-promotion-policy.mjs";
import {
  buildProofReferenceReceiptPath,
  countProofReferenceReceiptRefs,
  normalizePath,
} from "./write-proof-reference-receipt.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string");
}

function parseBooleanOption(value, flagName) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flagName} must be true or false.`);
}

function readAutoApproved(candidate) {
  return typeof candidate?.approval?.auto_approved === "boolean"
    ? candidate.approval.auto_approved
    : null;
}

function readOwnerBoundaryStatement(candidate) {
  return typeof candidate?.boundary?.statement === "string"
    ? candidate.boundary.statement
    : null;
}

function buildValidationErrors(policyResult) {
  const validationErrors = [
    ...policyResult.validation.schema_errors,
    ...policyResult.validation.canonical_ref_errors,
  ];

  if (policyResult.validation.missing_required_proof_refs.length > 0) {
    validationErrors.push(
      `source_refs is missing required proof refs: ${policyResult.validation.missing_required_proof_refs.join(", ")}.`,
    );
  }

  return validationErrors;
}

function createReadFailureResult({
  candidatePath,
  schemaPath,
  validationError,
}) {
  return {
    dry_run: true,
    receipt_would_write: false,
    intended_receipt_path: null,
    blocked: true,
    blocked_reason: "candidate_read_failed",
    promotion_policy_passed: false,
    schema_valid: false,
    explicit_human_approval: false,
    auto_approved: null,
    current_validation_debt: [],
    known_ambient_debt: [],
    proof_reference_count: 0,
    owner_boundary_statement: null,
    source_candidate_path: normalizePath(candidatePath),
    destination_safe: false,
    blocker_codes: ["candidate_read_failed"],
    validation_errors: [validationError],
    schema_path: normalizePath(path.resolve(schemaPath)),
  };
}

function selectBlockedReason(policyResult, blockerCodes) {
  if (isNonEmptyString(policyResult.validation.candidate_blocked_reason)) {
    return policyResult.validation.candidate_blocked_reason;
  }

  return blockerCodes[0] ?? null;
}

export async function dryRunProofReferenceReceiptPromotion({
  candidatePath,
  lifelineRoot = repoRoot,
  schemaPath = path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
  productionPromotionRequested = false,
  dryRunTestReceiptPassed = true,
  evidenceOrigin = "proof_reference_pack",
  stableProofReference = true,
}) {
  const resolvedCandidatePath = path.resolve(candidatePath);

  let candidate;
  try {
    const rawCandidate = await readFile(resolvedCandidatePath, "utf8");
    candidate = JSON.parse(rawCandidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createReadFailureResult({
      candidatePath: resolvedCandidatePath,
      schemaPath,
      validationError: message,
    });
  }

  const policyResult = await evaluateProofReferenceReceiptPromotionPolicy({
    candidate,
    sourceCandidatePath: resolvedCandidatePath,
    productionPromotionRequested,
    dryRunTestReceiptPassed,
    evidenceOrigin,
    stableProofReference,
    schemaPath,
  });

  let intendedReceiptPath = null;
  let pathComputationError = null;

  if (policyResult.checks.promotion_identifiers_explicit) {
    try {
      intendedReceiptPath = normalizePath(
        buildProofReferenceReceiptPath(candidate, lifelineRoot),
      );
    } catch (error) {
      pathComputationError = error instanceof Error ? error.message : String(error);
    }
  }

  const blockerCodes = [...policyResult.blocker_codes];
  if (pathComputationError && !blockerCodes.includes("unsafe_receipt_destination")) {
    blockerCodes.push("unsafe_receipt_destination");
  }

  const validationErrors = buildValidationErrors(policyResult);
  if (pathComputationError) {
    validationErrors.push(pathComputationError);
  }

  const blocked = blockerCodes.length > 0;

  return {
    dry_run: true,
    receipt_would_write: policyResult.promotion_eligible && intendedReceiptPath !== null,
    intended_receipt_path: intendedReceiptPath,
    blocked,
    blocked_reason: selectBlockedReason(policyResult, blockerCodes),
    promotion_policy_passed: policyResult.promotion_eligible,
    schema_valid: policyResult.validation.schema_valid,
    explicit_human_approval: policyResult.checks.explicit_human_approval,
    auto_approved: readAutoApproved(candidate),
    current_validation_debt: toStringArray(
      candidate?.validation_context?.current_validation_debt,
    ),
    known_ambient_debt: toStringArray(candidate?.validation_context?.known_ambient_debt),
    proof_reference_count: countProofReferenceReceiptRefs(candidate),
    owner_boundary_statement: readOwnerBoundaryStatement(candidate),
    source_candidate_path: normalizePath(resolvedCandidatePath),
    destination_safe:
      policyResult.checks.destination_segments_safe && pathComputationError === null,
    blocker_codes: blockerCodes,
    validation_errors: validationErrors,
    schema_path: normalizePath(path.resolve(policyResult.validation.schema_path)),
  };
}

function parseArgs(argv) {
  const options = {
    candidatePath: null,
    lifelineRoot: repoRoot,
    schemaPath: path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
    productionPromotionRequested: false,
    dryRunTestReceiptPassed: true,
    evidenceOrigin: "proof_reference_pack",
    stableProofReference: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--production-promotion-requested") {
      options.productionPromotionRequested = true;
      continue;
    }

    if (argument.startsWith("--dry-run-test-receipt-passed=")) {
      options.dryRunTestReceiptPassed = parseBooleanOption(
        argument.slice("--dry-run-test-receipt-passed=".length),
        "--dry-run-test-receipt-passed",
      );
      continue;
    }

    if (argument.startsWith("--stable-proof-reference=")) {
      options.stableProofReference = parseBooleanOption(
        argument.slice("--stable-proof-reference=".length),
        "--stable-proof-reference",
      );
      continue;
    }

    if (argument === "--evidence-origin") {
      const nextValue = argv[index + 1];
      if (!isNonEmptyString(nextValue)) {
        throw new Error("--evidence-origin requires a value.");
      }
      options.evidenceOrigin = nextValue;
      index += 1;
      continue;
    }

    if (argument === "--lifeline-root") {
      const nextValue = argv[index + 1];
      if (!isNonEmptyString(nextValue)) {
        throw new Error("--lifeline-root requires a value.");
      }
      options.lifelineRoot = path.resolve(nextValue);
      index += 1;
      continue;
    }

    if (argument === "--schema-path") {
      const nextValue = argv[index + 1];
      if (!isNonEmptyString(nextValue)) {
        throw new Error("--schema-path requires a value.");
      }
      options.schemaPath = path.resolve(nextValue);
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (options.candidatePath !== null) {
      throw new Error("Only one candidate payload path may be provided.");
    }
    options.candidatePath = argument;
  }

  if (!isNonEmptyString(options.candidatePath)) {
    throw new Error(
      "Usage: node scripts/dry-run-proof-reference-receipt-promotion.mjs <candidate-payload-path> [--production-promotion-requested]",
    );
  }

  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = await dryRunProofReferenceReceiptPromotion(options);
  console.log(JSON.stringify(result, null, 2));
  return result.receipt_would_write ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
