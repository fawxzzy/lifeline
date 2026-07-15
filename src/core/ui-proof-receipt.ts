import { access } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { ValidationError } from "./errors.js";
import { getLifelineReceiptsDirectory } from "./lifeline-root.js";
import {
  normalizeReceiptPath,
  stableJsonStringify,
  writeJsonFile,
} from "./receipt-store.js";

const UI_PROOF_SUMMARY_CONTRACT_VERSION = "atlas.ui.proof-summary.v1";
const UI_PROOF_PASSED_RECEIPT_CONTRACT_VERSION =
  "atlas.ui.proof-passed.receipt.v1";
const UI_PROOF_PASSED_RUNNER_VERSION = "lifeline.ui-proof-receipt.v1";

interface UiProofSummaryReport {
  status: string;
  report_ref: string;
  report_id?: string | null;
}

interface UiProofSummary {
  contract_version: string;
  report_id: string;
  owner_repo_id: string;
  completion_ready: boolean;
  summary: {
    semantic_status: string;
    visual_status: string;
  };
  semantic_proof: UiProofSummaryReport;
  visual_proof: UiProofSummaryReport;
}

export interface UiProofPassedReceipt {
  contract_version: string;
  receipt_id: string;
  emitted_at: string;
  runner_version: string;
  status: "proof_passed";
  source_repo_id: string;
  tranche_id: string;
  proof_summary: {
    owner_repo_id: string;
    summary_ref: string;
    report_id: string;
  };
  proof_refs: {
    semantic_report_ref: string;
    semantic_report_id?: string | null;
    visual_report_ref: string;
    visual_report_id?: string | null;
  };
  source_refs: string[];
}

export interface EmitUiProofPassedReceiptResult {
  receipt: UiProofPassedReceipt;
  receiptPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string.`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function asOptionalStringOrNull(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return asString(value, field);
}

async function loadJsonObject(
  filePath: string,
): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ValidationError(
      `Could not read JSON file at ${normalizeReceiptPath(filePath)}: ${message}`,
    );
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new ValidationError(
      `Could not parse JSON in ${normalizeReceiptPath(filePath)}: ${message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ValidationError(
      `JSON file at ${normalizeReceiptPath(filePath)} must contain an object.`,
    );
  }

  return parsed;
}

function validateProofReport(
  value: unknown,
  field: string,
): UiProofSummaryReport {
  if (!isRecord(value)) {
    throw new ValidationError(`${field} must be an object.`);
  }
  const reportId = asOptionalStringOrNull(value.report_id, `${field}.report_id`);

  return {
    status: asString(value.status, `${field}.status`),
    report_ref: asString(value.report_ref, `${field}.report_ref`),
    ...(reportId !== undefined ? { report_id: reportId } : {}),
  };
}

function validateUiProofSummary(value: unknown): UiProofSummary {
  if (!isRecord(value)) {
    throw new ValidationError("UI proof summary must be an object.");
  }

  if (value.contract_version !== UI_PROOF_SUMMARY_CONTRACT_VERSION) {
    throw new ValidationError(
      `proof_summary.contract_version must be '${UI_PROOF_SUMMARY_CONTRACT_VERSION}'.`,
    );
  }

  const summaryBlock = value.summary;
  if (!isRecord(summaryBlock)) {
    throw new ValidationError("proof_summary.summary must be an object.");
  }

  return {
    contract_version: UI_PROOF_SUMMARY_CONTRACT_VERSION,
    report_id: asString(value.report_id, "proof_summary.report_id"),
    owner_repo_id: asString(
      value.owner_repo_id,
      "proof_summary.owner_repo_id",
    ),
    completion_ready: asBoolean(
      value.completion_ready,
      "proof_summary.completion_ready",
    ),
    summary: {
      semantic_status: asString(
        summaryBlock.semantic_status,
        "proof_summary.summary.semantic_status",
      ),
      visual_status: asString(
        summaryBlock.visual_status,
        "proof_summary.summary.visual_status",
      ),
    },
    semantic_proof: validateProofReport(
      value.semantic_proof,
      "proof_summary.semantic_proof",
    ),
    visual_proof: validateProofReport(
      value.visual_proof,
      "proof_summary.visual_proof",
    ),
  };
}

async function findAtlasRoot(startPath: string): Promise<string | null> {
  const envRoot = process.env.ATLAS_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }

  let current = path.resolve(startPath);
  while (true) {
    try {
      await access(path.join(current, "stack.yaml"));
      return current;
    } catch {
      // Keep walking upward until the drive root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function relativeAtlasRef(atlasRoot: string, targetPath: string): string {
  return normalizeReceiptPath(path.relative(atlasRoot, targetPath));
}

function canonicalizeAtlasRef(atlasRoot: string | null, ref: string): string {
  const normalizedRef = normalizeReceiptPath(ref);
  if (!atlasRoot) {
    return normalizedRef;
  }

  const resolvedPath = resolveRefPath(atlasRoot, ref);
  const relativeRef = path.relative(atlasRoot, resolvedPath);
  if (
    relativeRef.length > 0 &&
    !relativeRef.startsWith("..") &&
    !path.isAbsolute(relativeRef)
  ) {
    return normalizeReceiptPath(relativeRef);
  }

  return normalizedRef;
}

function resolveRefPath(atlasRoot: string | null, ref: string): string {
  if (path.isAbsolute(ref)) {
    return path.resolve(ref);
  }
  if (!atlasRoot) {
    throw new ValidationError(
      `Could not resolve relative proof report ref '${normalizeReceiptPath(ref)}' without an ATLAS root.`,
    );
  }
  return path.resolve(atlasRoot, ref);
}

async function ensureReadableRef(
  atlasRoot: string | null,
  ref: string,
  field: string,
): Promise<void> {
  const resolvedPath = resolveRefPath(atlasRoot, ref);
  await access(resolvedPath).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ValidationError(
      `${field} points to an unreadable file at ${normalizeReceiptPath(resolvedPath)}: ${message}`,
    );
  });
}

function digestReceiptIdentity(value: {
  sourceRepoId: string;
  trancheId: string;
  proofSummaryRef: string;
  proofSummaryReportId: string;
  semanticReportRef: string;
  semanticReportId?: string | null;
  visualReportRef: string;
  visualReportId?: string | null;
}): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex")}`;
}

export async function emitUiProofPassedReceipt(options: {
  proofSummaryPath: string;
  sourceRepoId: string;
  trancheId: string;
  receiptDir?: string;
}): Promise<EmitUiProofPassedReceiptResult> {
  const proofSummaryPath = path.resolve(options.proofSummaryPath);
  const atlasRoot = await findAtlasRoot(path.dirname(proofSummaryPath));
  const proofSummary = validateUiProofSummary(
    await loadJsonObject(proofSummaryPath),
  );

  if (proofSummary.owner_repo_id !== options.sourceRepoId) {
    throw new ValidationError(
      `source_repo_id '${options.sourceRepoId}' does not match proof summary owner_repo_id '${proofSummary.owner_repo_id}'.`,
    );
  }

  if (!proofSummary.completion_ready) {
    throw new ValidationError(
      `Proof summary at ${proofSummaryPath} is not completion_ready.`,
    );
  }

  if (
    proofSummary.summary.semantic_status !== "clean" ||
    proofSummary.semantic_proof.status !== "clean"
  ) {
    throw new ValidationError(
      `Proof summary at ${proofSummaryPath} does not have clean semantic proof.`,
    );
  }

  if (
    proofSummary.summary.visual_status !== "clean" ||
    proofSummary.visual_proof.status !== "clean"
  ) {
    throw new ValidationError(
      `Proof summary at ${proofSummaryPath} does not have clean visual proof.`,
    );
  }

  await ensureReadableRef(
    atlasRoot,
    proofSummary.semantic_proof.report_ref,
    "proof_summary.semantic_proof.report_ref",
  );
  await ensureReadableRef(
    atlasRoot,
    proofSummary.visual_proof.report_ref,
    "proof_summary.visual_proof.report_ref",
  );

  const proofSummaryRef = atlasRoot
    ? relativeAtlasRef(atlasRoot, proofSummaryPath)
    : normalizeReceiptPath(proofSummaryPath);
  const semanticReportRef = canonicalizeAtlasRef(
    atlasRoot,
    proofSummary.semantic_proof.report_ref,
  );
  const visualReportRef = canonicalizeAtlasRef(
    atlasRoot,
    proofSummary.visual_proof.report_ref,
  );
  const receiptIdentity = {
    sourceRepoId: options.sourceRepoId,
    trancheId: options.trancheId,
    proofSummaryRef,
    proofSummaryReportId: proofSummary.report_id,
    semanticReportRef,
    visualReportRef,
    ...(proofSummary.semantic_proof.report_id !== undefined
      ? { semanticReportId: proofSummary.semantic_proof.report_id }
      : {}),
    ...(proofSummary.visual_proof.report_id !== undefined
      ? { visualReportId: proofSummary.visual_proof.report_id }
      : {}),
  };
  const receiptId = digestReceiptIdentity(receiptIdentity);
  const emittedAt = new Date().toISOString();
  const receipt: UiProofPassedReceipt = {
    contract_version: UI_PROOF_PASSED_RECEIPT_CONTRACT_VERSION,
    receipt_id: receiptId,
    emitted_at: emittedAt,
    runner_version: UI_PROOF_PASSED_RUNNER_VERSION,
    status: "proof_passed",
    source_repo_id: options.sourceRepoId,
    tranche_id: options.trancheId,
    proof_summary: {
      owner_repo_id: proofSummary.owner_repo_id,
      summary_ref: proofSummaryRef,
      report_id: proofSummary.report_id,
    },
    proof_refs: {
      semantic_report_ref: semanticReportRef,
      ...(proofSummary.semantic_proof.report_id !== undefined
        ? { semantic_report_id: proofSummary.semantic_proof.report_id }
        : {}),
      visual_report_ref: visualReportRef,
      ...(proofSummary.visual_proof.report_id !== undefined
        ? { visual_report_id: proofSummary.visual_proof.report_id }
        : {}),
    },
    source_refs: [proofSummaryRef, semanticReportRef, visualReportRef],
  };

  const receiptDir = resolveUiProofPassedReceiptDirectory({
    sourceRepoId: options.sourceRepoId,
    trancheId: options.trancheId,
    ...(options.receiptDir !== undefined
      ? { receiptDir: options.receiptDir }
      : {}),
  });
  const receiptPath = path.join(
    receiptDir,
    `${receipt.receipt_id.replace(":", "-")}.json`,
  );
  await writeJsonFile(receiptPath, receipt);

  return {
    receipt,
    receiptPath,
  };
}

export function resolveUiProofPassedReceiptDirectory(options: {
  sourceRepoId: string;
  trancheId: string;
  receiptDir?: string;
}): string {
  return (
    options.receiptDir ??
    path.join(
      getLifelineReceiptsDirectory(),
      "proof-passed",
      options.sourceRepoId,
      options.trancheId,
    )
  );
}
