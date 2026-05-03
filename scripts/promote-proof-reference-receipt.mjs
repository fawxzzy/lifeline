import path from "node:path";
import { fileURLToPath } from "node:url";

import { dryRunProofReferenceReceiptPromotion } from "./dry-run-proof-reference-receipt-promotion.mjs";
import { writeProofReferenceReceipt } from "./write-proof-reference-receipt.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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
      const value = argument.slice("--dry-run-test-receipt-passed=".length);
      if (value !== "true" && value !== "false") {
        throw new Error("--dry-run-test-receipt-passed must be true or false.");
      }
      options.dryRunTestReceiptPassed = value === "true";
      continue;
    }

    if (argument.startsWith("--stable-proof-reference=")) {
      const value = argument.slice("--stable-proof-reference=".length);
      if (value !== "true" && value !== "false") {
        throw new Error("--stable-proof-reference must be true or false.");
      }
      options.stableProofReference = value === "true";
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
      "Usage: node scripts/promote-proof-reference-receipt.mjs <candidate-payload-path> --production-promotion-requested",
    );
  }

  return options;
}

function createPromotionResult({
  promoted,
  receiptWritten,
  receiptPath,
  dryRunResult,
  productionPromotionRequested,
  blocked,
  blockedReason,
  validationErrors = [],
  blockerCodes = [],
}) {
  return {
    promoted,
    receipt_written: receiptWritten,
    receipt_path: receiptPath,
    source_candidate_path: dryRunResult.source_candidate_path,
    dry_run_passed: dryRunResult.receipt_would_write,
    production_promotion_requested: productionPromotionRequested === true,
    explicit_human_approval: dryRunResult.explicit_human_approval,
    auto_approved: dryRunResult.auto_approved,
    blocked,
    blocked_reason: blockedReason,
    proof_reference_count: dryRunResult.proof_reference_count,
    owner_boundary_statement: dryRunResult.owner_boundary_statement,
    validation_errors: validationErrors,
    blocker_codes: blockerCodes,
  };
}

export async function promoteProofReferenceReceipt(options) {
  const dryRunResult = await dryRunProofReferenceReceiptPromotion(options);

  if (!dryRunResult.receipt_would_write) {
    return createPromotionResult({
      promoted: false,
      receiptWritten: false,
      receiptPath: null,
      dryRunResult,
      productionPromotionRequested: options.productionPromotionRequested,
      blocked: true,
      blockedReason: dryRunResult.blocked_reason,
      validationErrors: dryRunResult.validation_errors,
      blockerCodes: dryRunResult.blocker_codes,
    });
  }

  const writeResult = await writeProofReferenceReceipt({
    candidatePath: options.candidatePath,
    lifelineRoot: options.lifelineRoot,
    schemaPath: options.schemaPath,
  });

  if (writeResult.receipt_written !== true) {
    return createPromotionResult({
      promoted: false,
      receiptWritten: false,
      receiptPath: null,
      dryRunResult,
      productionPromotionRequested: options.productionPromotionRequested,
      blocked: true,
      blockedReason: writeResult.blocked_reason,
      validationErrors: writeResult.validation_errors,
      blockerCodes: writeResult.blocked_reason ? [writeResult.blocked_reason] : [],
    });
  }

  return createPromotionResult({
    promoted: true,
    receiptWritten: true,
    receiptPath: writeResult.receipt_path,
    dryRunResult,
    productionPromotionRequested: options.productionPromotionRequested,
    blocked: false,
    blockedReason: null,
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = await promoteProofReferenceReceipt(options);
  console.log(JSON.stringify(result, null, 2));
  return result.promoted ? 0 : 1;
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
