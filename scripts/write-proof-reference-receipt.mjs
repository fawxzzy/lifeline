import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

export const PROOF_REFERENCE_RECEIPT_CONTRACT_VERSION =
  "atlas.lifeline.proof-reference.receipt.v1";
export const PROOF_REFERENCE_RECEIPT_RUNNER_VERSION =
  "lifeline.proof-reference-receipt.v1";
export const PROOF_REFERENCE_RECEIPT_DESTINATION_SEGMENTS = [
  ".lifeline",
  "receipts",
  "proof-reference-accepted",
];

export function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }

  if (value && typeof value === "object") {
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
  return JSON.stringify(stableJsonValue(value), null, 2);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function findAtlasRoot(startPath) {
  const envRoot = process.env.ATLAS_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }

  let current = path.resolve(startPath);
  while (true) {
    try {
      await readFile(path.join(current, "stack.yaml"), "utf8");
      return current;
    } catch {
      // Keep walking upward.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function makePointer(pointer, segment) {
  return pointer === "$" ? `$.${segment}` : `${pointer}.${segment}`;
}

function validateSchemaNode(schema, value, pointer, errors) {
  if (!isRecord(schema)) {
    errors.push(`${pointer} schema node must be an object.`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) {
      errors.push(`${pointer} must be ${JSON.stringify(schema.const)}.`);
    }
  }

  if (
    schema.type === "object" ||
    Array.isArray(schema.required) ||
    isRecord(schema.properties) ||
    schema.additionalProperties === false
  ) {
    if (!isRecord(value)) {
      errors.push(`${pointer} must be an object.`);
      return;
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        errors.push(`${pointer}.${field} is required.`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, field)) {
          errors.push(`${pointer}.${field} is not allowed.`);
        }
      }
    }

    for (const [field, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        continue;
      }
      validateSchemaNode(childSchema, value[field], makePointer(pointer, field), errors);
    }

    if (Array.isArray(schema.anyOf)) {
      const matched = schema.anyOf.some((option) => {
        const optionErrors = [];
        validateSchemaNode(option, value, pointer, optionErrors);
        return optionErrors.length === 0;
      });
      if (!matched) {
        errors.push(`${pointer} must satisfy at least one anyOf branch.`);
      }
    }

    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${pointer} must be an array.`);
      return;
    }

    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${pointer} must contain at least ${schema.minItems} item(s).`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${pointer} must contain at most ${schema.maxItems} item(s).`);
    }

    if (schema.items) {
      value.forEach((entry, index) => {
        validateSchemaNode(schema.items, entry, `${pointer}[${index}]`, errors);
      });
    }
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${pointer} must be a string.`);
      return;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pointer} must be at least ${schema.minLength} character(s).`);
    }
  }
}

function collectRequiredProofRefs(candidate) {
  return [
    ["source_artifacts.proof_reference_pack_ref", candidate?.source_artifacts?.proof_reference_pack_ref],
    ["source_artifacts.write_ready_artifact_ref", candidate?.source_artifacts?.write_ready_artifact_ref],
    ["proof_summary.summary_ref", candidate?.proof_summary?.summary_ref],
    ["proof_refs.semantic_report_ref", candidate?.proof_refs?.semantic_report_ref],
    ["proof_refs.visual_report_ref", candidate?.proof_refs?.visual_report_ref],
  ];
}

function hasExplicitHumanApproval(candidate) {
  return candidate?.approval?.explicit_human_approval === true;
}

function hasReviewerIdentity(candidate) {
  return [candidate?.approval?.reviewer_id, candidate?.approval?.reviewer_label].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function hasApprovalNote(candidate) {
  return (
    typeof candidate?.approval?.approval_note === "string" &&
    candidate.approval.approval_note.trim().length > 0
  );
}

function hasOwnerBoundaryStatement(candidate) {
  return (
    typeof candidate?.boundary?.statement === "string" &&
    candidate.boundary.statement.trim().length > 0
  );
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

function hasCurrentValidationDebt(candidate) {
  return (
    Array.isArray(candidate?.validation_context?.current_validation_debt) &&
    candidate.validation_context.current_validation_debt.length > 0
  );
}

function missingRequiredProofRefs(candidate) {
  const requiredRefs = collectRequiredProofRefs(candidate);
  const sourceRefs = Array.isArray(candidate?.source_refs) ? candidate.source_refs : [];
  const missing = [];

  for (const [field, value] of requiredRefs) {
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(field);
      continue;
    }
    if (!sourceRefs.includes(value)) {
      missing.push(value);
    }
  }

  return missing;
}

export function countProofReferenceReceiptRefs(candidate) {
  let count = 0;
  if (
    typeof candidate?.proof_refs?.semantic_report_ref === "string" &&
    candidate.proof_refs.semantic_report_ref.trim().length > 0
  ) {
    count += 1;
  }
  if (
    typeof candidate?.proof_refs?.visual_report_ref === "string" &&
    candidate.proof_refs.visual_report_ref.trim().length > 0
  ) {
    count += 1;
  }
  return count;
}

function validateSafePathSegment(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${field} must be a non-empty string.`;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return `${field} must use only letters, digits, dot, underscore, dash, or colon.`;
  }
  if (value === "." || value === "..") {
    return `${field} must not be a path traversal segment.`;
  }
  return null;
}

function validateCanonicalRef(ref, field) {
  if (ref === undefined || ref === null) {
    return null;
  }
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return `${field} must be a non-empty string ref.`;
  }
  if (ref.includes("\\")) {
    return `${field} must stay slash-normalized.`;
  }
  if (path.isAbsolute(ref)) {
    return `${field} must stay stack-relative.`;
  }
  return null;
}

function collectCanonicalRefErrors(candidate) {
  const errors = [];
  const refFields = [
    ["source_artifacts.proof_reference_pack_ref", candidate?.source_artifacts?.proof_reference_pack_ref],
    ["source_artifacts.write_ready_artifact_ref", candidate?.source_artifacts?.write_ready_artifact_ref],
    ["proof_summary.summary_ref", candidate?.proof_summary?.summary_ref],
    ["proof_refs.semantic_report_ref", candidate?.proof_refs?.semantic_report_ref],
    ["proof_refs.visual_report_ref", candidate?.proof_refs?.visual_report_ref],
  ];

  for (const [field, value] of refFields) {
    const error = validateCanonicalRef(value, field);
    if (error) {
      errors.push(error);
    }
  }

  if (Array.isArray(candidate?.source_refs)) {
    candidate.source_refs.forEach((entry, index) => {
      const error = validateCanonicalRef(entry, `source_refs[${index}]`);
      if (error) {
        errors.push(error);
      }
    });
  }

  return errors;
}

function determineBlockedReason(candidate, schemaErrors) {
  if (candidate?.approval?.auto_approved === true) {
    return "auto_approval_forbidden";
  }
  if (!hasExplicitHumanApproval(candidate)) {
    return "missing_explicit_human_approval";
  }
  if (!hasReviewerIdentity(candidate) || !hasApprovalNote(candidate)) {
    return "missing_human_approval_metadata";
  }
  if (hasCurrentValidationDebt(candidate)) {
    return "current_validation_debt_present";
  }
  if (!hasOwnerBoundaryStatement(candidate)) {
    return "missing_owner_boundary_statement";
  }
  if (!preservesOwnerBoundary(candidate)) {
    return "invalid_owner_boundary_statement";
  }
  if (
    isRecord(candidate?.proof_summary) &&
    typeof candidate?.source_repo_id === "string" &&
    candidate.proof_summary.owner_repo_id !== candidate.source_repo_id
  ) {
    return "source_repo_mismatch";
  }
  if (missingRequiredProofRefs(candidate).length > 0) {
    return "missing_required_proof_refs";
  }
  if (collectCanonicalRefErrors(candidate).length > 0) {
    return "noncanonical_ref";
  }
  if (
    typeof candidate?.source_repo_id === "string" &&
    validateSafePathSegment(candidate.source_repo_id, "source_repo_id")
  ) {
    return "unsafe_receipt_destination";
  }
  if (
    typeof candidate?.tranche_id === "string" &&
    validateSafePathSegment(candidate.tranche_id, "tranche_id")
  ) {
    return "unsafe_receipt_destination";
  }
  if (
    typeof candidate?.receipt_id === "string" &&
    validateSafePathSegment(candidate.receipt_id, "receipt_id")
  ) {
    return "unsafe_receipt_destination";
  }
  if (schemaErrors.length > 0) {
    return "schema_validation_failed";
  }
  return null;
}

export function getProofReferenceReceiptDestinationRoot(lifelineRoot = repoRoot) {
  return path.resolve(lifelineRoot, ...PROOF_REFERENCE_RECEIPT_DESTINATION_SEGMENTS);
}

export function buildProofReferenceReceiptPath(candidate, lifelineRoot) {
  const destinationRoot = getProofReferenceReceiptDestinationRoot(lifelineRoot);
  const receiptFileName = `${candidate.receipt_id.replaceAll(":", "-")}.json`;
  const receiptPath = path.resolve(
    destinationRoot,
    candidate.source_repo_id,
    candidate.tranche_id,
    receiptFileName,
  );
  const relativePath = path.relative(destinationRoot, receiptPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      "Resolved receipt path escapes the Lifeline-owned proof-reference receipt destination.",
    );
  }
  return receiptPath;
}

export async function validateProofReferenceReceiptCandidate({
  candidate,
  schemaPath = path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
}) {
  const schema = await readJson(schemaPath);
  const schemaErrors = [];
  validateSchemaNode(schema, candidate, "$", schemaErrors);
  const canonicalRefErrors = collectCanonicalRefErrors(candidate);
  const blockedReason = determineBlockedReason(candidate, schemaErrors);

  return {
    schemaPath: path.resolve(schemaPath),
    schemaValid: schemaErrors.length === 0,
    schemaErrors,
    canonicalRefErrors,
    missingRequiredProofRefs: missingRequiredProofRefs(candidate),
    blockedReason,
  };
}

export async function writeProofReferenceReceipt({
  candidatePath,
  lifelineRoot = repoRoot,
  schemaPath = path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
}) {
  const resolvedCandidatePath = path.resolve(candidatePath);
  const normalizedCandidatePath = normalizePath(resolvedCandidatePath);
  const atlasRoot = await findAtlasRoot(path.dirname(resolvedCandidatePath));

  let candidate;
  try {
    candidate = await readJson(resolvedCandidatePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      receipt_written: false,
      receipt_path: null,
      source_candidate_path: normalizedCandidatePath,
      reviewer_label: null,
      auto_approved: null,
      blocked: true,
      blocked_reason: "candidate_read_failed",
      proof_reference_count: 0,
      owner_boundary_statement: null,
      validation_errors: [message],
      schema_valid: false,
      schema_path: normalizePath(path.resolve(schemaPath)),
      atlas_root: atlasRoot ? normalizePath(atlasRoot) : null,
    };
  }

  const validation = await validateProofReferenceReceiptCandidate({
    candidate,
    schemaPath,
  });
  const validationErrors = [
    ...validation.schemaErrors,
    ...validation.canonicalRefErrors,
    ...(validation.missingRequiredProofRefs.length > 0
      ? [
          `source_refs is missing required proof refs: ${validation.missingRequiredProofRefs.join(", ")}.`,
        ]
      : []),
  ];
  const blocked = validation.blockedReason !== null;
  const result = {
    receipt_written: false,
    receipt_path: null,
    source_candidate_path: normalizedCandidatePath,
    reviewer_label:
      typeof candidate?.approval?.reviewer_label === "string"
        ? candidate.approval.reviewer_label
        : null,
    auto_approved:
      typeof candidate?.approval?.auto_approved === "boolean"
        ? candidate.approval.auto_approved
        : null,
    blocked,
    blocked_reason: validation.blockedReason,
    proof_reference_count: countProofReferenceReceiptRefs(candidate),
    owner_boundary_statement:
      typeof candidate?.boundary?.statement === "string"
        ? candidate.boundary.statement
        : null,
    validation_errors: validationErrors,
    schema_valid: validation.schemaValid,
    schema_path: normalizePath(validation.schemaPath),
    atlas_root: atlasRoot ? normalizePath(atlasRoot) : null,
  };

  if (blocked) {
    return result;
  }

  const finalReceipt = {
    ...candidate,
    contract_version: PROOF_REFERENCE_RECEIPT_CONTRACT_VERSION,
    runner_version: PROOF_REFERENCE_RECEIPT_RUNNER_VERSION,
  };
  const receiptPath = buildProofReferenceReceiptPath(finalReceipt, lifelineRoot);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${stableJsonStringify(finalReceipt)}\n`, "utf8");

  return {
    ...result,
    receipt_written: true,
    receipt_path: normalizePath(receiptPath),
    blocked: false,
    blocked_reason: null,
  };
}

async function main(argv) {
  const [candidatePath] = argv;
  if (!candidatePath) {
    console.error(
      "Usage: node scripts/write-proof-reference-receipt.mjs <candidate-payload-path>",
    );
    return 1;
  }

  const result = await writeProofReferenceReceipt({ candidatePath });
  console.log(JSON.stringify(result, null, 2));
  return result.blocked ? 1 : 0;
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
