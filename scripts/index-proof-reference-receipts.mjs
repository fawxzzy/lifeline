import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  countProofReferenceReceiptRefs,
  getProofReferenceReceiptDestinationRoot,
  normalizePath,
  validateProofReferenceReceiptCandidate,
} from "./write-proof-reference-receipt.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

export const PROOF_REFERENCE_RECEIPT_AUDIT_ARTIFACT_SEGMENTS = [
  ".lifeline",
  "audits",
  "proof-reference-receipt-index.json",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string");
}

function buildReceiptGrouping(entries, fieldName) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = entry[fieldName] ?? "__missing__";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(entry.receipt_path);
  }

  return sortStrings([...grouped.keys()]).reduce((accumulator, key) => {
    accumulator[key] = sortStrings(grouped.get(key));
    return accumulator;
  }, {});
}

function buildInvalidReceiptEntry(entry) {
  return {
    receipt_path: entry.receipt_path,
    path_source_repo_id: entry.path_source_repo_id,
    path_tranche_id: entry.path_tranche_id,
    source_repo_id: entry.source_repo_id,
    tranche_id: entry.tranche_id,
    receipt_id: entry.receipt_id,
    parsed: entry.parsed,
    schema_valid: entry.schema_valid,
    blocked_reason: entry.blocked_reason,
    validation_errors: entry.validation_errors,
  };
}

function buildValidationErrors(validation) {
  const validationErrors = [
    ...validation.schemaErrors,
    ...validation.canonicalRefErrors,
  ];

  if (validation.missingRequiredProofRefs.length > 0) {
    validationErrors.push(
      `source_refs is missing required proof refs: ${validation.missingRequiredProofRefs.join(", ")}.`,
    );
  }

  return validationErrors;
}

async function listReceiptFiles(receiptsRoot) {
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  await walk(receiptsRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function createParseFailureEntry({ receiptPath, lifelineRoot, receiptsRoot, errorMessage }) {
  const relativeReceiptPath = normalizePath(path.relative(lifelineRoot, receiptPath));
  const relativeToReceiptsRoot = path.relative(receiptsRoot, receiptPath).split(path.sep);

  return {
    receipt_path: relativeReceiptPath,
    path_source_repo_id: relativeToReceiptsRoot[0] ?? null,
    path_tranche_id: relativeToReceiptsRoot[1] ?? null,
    source_repo_id: null,
    tranche_id: null,
    receipt_id: null,
    emitted_at: null,
    parsed: false,
    schema_valid: false,
    proof_reference_count: 0,
    has_known_ambient_debt: false,
    has_current_validation_debt: false,
    has_owner_boundary_statement: null,
    auto_approved: null,
    blocked_reason: "receipt_parse_failed",
    validation_errors: [errorMessage],
  };
}

async function inspectReceipt({ receiptPath, lifelineRoot, receiptsRoot, schemaPath }) {
  const relativeReceiptPath = normalizePath(path.relative(lifelineRoot, receiptPath));
  const relativeToReceiptsRoot = path.relative(receiptsRoot, receiptPath).split(path.sep);
  let candidate;

  try {
    const raw = await readFile(receiptPath, "utf8");
    candidate = JSON.parse(raw);
  } catch (error) {
    return createParseFailureEntry({
      receiptPath,
      lifelineRoot,
      receiptsRoot,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const validation = await validateProofReferenceReceiptCandidate({
    candidate,
    schemaPath,
  });

  return {
    receipt_path: relativeReceiptPath,
    path_source_repo_id: relativeToReceiptsRoot[0] ?? null,
    path_tranche_id: relativeToReceiptsRoot[1] ?? null,
    source_repo_id: isNonEmptyString(candidate?.source_repo_id) ? candidate.source_repo_id : null,
    tranche_id: isNonEmptyString(candidate?.tranche_id) ? candidate.tranche_id : null,
    receipt_id: isNonEmptyString(candidate?.receipt_id) ? candidate.receipt_id : null,
    emitted_at: isNonEmptyString(candidate?.emitted_at) ? candidate.emitted_at : null,
    parsed: true,
    schema_valid: validation.schemaValid,
    proof_reference_count: countProofReferenceReceiptRefs(candidate),
    has_known_ambient_debt: toStringArray(
      candidate?.validation_context?.known_ambient_debt,
    ).length > 0,
    has_current_validation_debt: toStringArray(
      candidate?.validation_context?.current_validation_debt,
    ).length > 0,
    has_owner_boundary_statement:
      typeof candidate?.boundary?.statement === "string" &&
      candidate.boundary.statement.trim().length > 0,
    auto_approved:
      typeof candidate?.approval?.auto_approved === "boolean"
        ? candidate.approval.auto_approved
        : null,
    blocked_reason: validation.blockedReason,
    validation_errors: buildValidationErrors(validation),
  };
}

export function getProofReferenceReceiptAuditArtifactPath(lifelineRoot = repoRoot) {
  return path.resolve(lifelineRoot, ...PROOF_REFERENCE_RECEIPT_AUDIT_ARTIFACT_SEGMENTS);
}

export async function indexProofReferenceReceipts({
  lifelineRoot = repoRoot,
  schemaPath = path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
  writeAuditArtifact = false,
  auditArtifactPath = getProofReferenceReceiptAuditArtifactPath(lifelineRoot),
}) {
  const resolvedLifelineRoot = path.resolve(lifelineRoot);
  const resolvedSchemaPath = path.resolve(schemaPath);
  const receiptsRoot = getProofReferenceReceiptDestinationRoot(resolvedLifelineRoot);
  const receiptFiles = await listReceiptFiles(receiptsRoot);

  const receiptInventory = [];
  for (const receiptPath of receiptFiles) {
    receiptInventory.push(
      await inspectReceipt({
        receiptPath,
        lifelineRoot: resolvedLifelineRoot,
        receiptsRoot,
        schemaPath: resolvedSchemaPath,
      }),
    );
  }

  receiptInventory.sort((left, right) => left.receipt_path.localeCompare(right.receipt_path));

  const invalidReceipts = receiptInventory
    .filter((entry) => entry.schema_valid === false)
    .map((entry) => buildInvalidReceiptEntry(entry));

  const result = {
    receipt_count: receiptInventory.length,
    valid_receipt_count: receiptInventory.filter((entry) => entry.schema_valid === true).length,
    invalid_receipt_count: invalidReceipts.length,
    receipts_by_source_repo_id: buildReceiptGrouping(receiptInventory, "path_source_repo_id"),
    receipts_by_tranche_id: buildReceiptGrouping(receiptInventory, "path_tranche_id"),
    proof_reference_count_total: receiptInventory.reduce(
      (total, entry) => total + entry.proof_reference_count,
      0,
    ),
    receipts_with_ambient_debt: receiptInventory
      .filter((entry) => entry.has_known_ambient_debt === true)
      .map((entry) => entry.receipt_path),
    receipts_with_current_validation_debt: receiptInventory
      .filter((entry) => entry.has_current_validation_debt === true)
      .map((entry) => entry.receipt_path),
    receipts_missing_boundary_statement: receiptInventory
      .filter((entry) => entry.parsed === true && entry.has_owner_boundary_statement === false)
      .map((entry) => entry.receipt_path),
    receipts_with_auto_approved_not_false: receiptInventory
      .filter((entry) => entry.parsed === true && entry.auto_approved !== false)
      .map((entry) => entry.receipt_path),
    invalid_receipts: invalidReceipts,
    receipt_inventory: receiptInventory,
    receipts_root: normalizePath(receiptsRoot),
    schema_path: normalizePath(resolvedSchemaPath),
    audit_artifact_written: false,
    audit_artifact_path: null,
  };

  if (!writeAuditArtifact) {
    return result;
  }

  const resolvedAuditArtifactPath = path.resolve(auditArtifactPath);
  await mkdir(path.dirname(resolvedAuditArtifactPath), { recursive: true });

  const artifactResult = {
    ...result,
    audit_artifact_written: true,
    audit_artifact_path: normalizePath(resolvedAuditArtifactPath),
  };
  await writeFile(
    resolvedAuditArtifactPath,
    `${stableJsonStringify(artifactResult)}\n`,
    "utf8",
  );

  return artifactResult;
}

function parseArgs(argv) {
  const options = {
    lifelineRoot: repoRoot,
    schemaPath: path.join(repoRoot, "schemas", "proof-reference-receipt.schema.json"),
    writeAuditArtifact: false,
    auditArtifactPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

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

    if (argument === "--write-audit-artifact") {
      options.writeAuditArtifact = true;
      continue;
    }

    if (argument === "--audit-artifact-path") {
      const nextValue = argv[index + 1];
      if (!isNonEmptyString(nextValue)) {
        throw new Error("--audit-artifact-path requires a value.");
      }
      options.auditArtifactPath = path.resolve(nextValue);
      options.writeAuditArtifact = true;
      index += 1;
      continue;
    }

    throw new Error(
      "Usage: node scripts/index-proof-reference-receipts.mjs [--lifeline-root <path>] [--schema-path <path>] [--write-audit-artifact] [--audit-artifact-path <path>]",
    );
  }

  if (options.auditArtifactPath === null) {
    options.auditArtifactPath = getProofReferenceReceiptAuditArtifactPath(options.lifelineRoot);
  }

  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = await indexProofReferenceReceipts(options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
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
