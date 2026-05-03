import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getProofReferenceReceiptAuditArtifactPath,
  indexProofReferenceReceipts,
} from "./index-proof-reference-receipts.mjs";
import { getProofReferenceReceiptDestinationRoot } from "./write-proof-reference-receipt.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const indexScriptPath = path.join(
  repoRoot,
  "scripts",
  "index-proof-reference-receipts.mjs",
);

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function createBaseReceipt() {
  return {
    contract_version: "atlas.lifeline.proof-reference.receipt.v1",
    receipt_id: "sha256:proof-reference-accepted-f11",
    emitted_at: "2026-04-28T18:42:00.000Z",
    runner_version: "lifeline.proof-reference-receipt.v1",
    status: "proof_reference_accepted",
    source_repo_id: "fitness",
    tranche_id: "F11",
    source_artifacts: {
      proof_reference_pack_ref:
        "runtime/cortex/proof-reference-packs/runs/cortex-run-result.latest.json",
      proof_reference_pack_digest: "sha256:proof-reference-pack-digest",
      write_ready_artifact_ref:
        "runtime/cortex/lifeline-write-ready/runs/cortex-run-result.latest.json",
    },
    approval: {
      explicit_human_approval: true,
      auto_approved: false,
      approved_at: "2026-04-28T18:41:00.000Z",
      reviewer_label: "Lane Y reviewer",
      approval_note:
        "Explicit human approval recorded after reviewing the proof-reference pack and Lifeline contract.",
    },
    boundary: {
      final_receipt_owner: "lifeline",
      prepared_by: "cortex",
      statement:
        "Cortex prepared the proof-reference material, but Lifeline owns final receipt truth and writes the final receipt only after explicit human approval.",
    },
    proof_summary: {
      owner_repo_id: "fitness",
      summary_ref: "runtime/atlas/ui-proof/fitness/latest.json",
      report_id: "sha256:proof-summary-clean",
    },
    proof_refs: {
      semantic_report_ref: "runtime/atlas/ui-observe/drift/fitness/latest.json",
      semantic_report_id: "sha256:semantic-proof-clean",
      visual_report_ref: "runtime/atlas/ui-visual-proof/fitness/latest.json",
      visual_report_id: "sha256:visual-proof-clean",
    },
    source_refs: [
      "runtime/cortex/proof-reference-packs/runs/cortex-run-result.latest.json",
      "runtime/cortex/lifeline-write-ready/runs/cortex-run-result.latest.json",
      "runtime/atlas/ui-proof/fitness/latest.json",
      "runtime/atlas/ui-observe/drift/fitness/latest.json",
      "runtime/atlas/ui-visual-proof/fitness/latest.json",
    ],
    validation_context: {
      known_ambient_debt: ["critical=345, error=14, warning=181"],
      current_validation_debt: [],
    },
  };
}

function mergeReceipt(overrides) {
  const receipt = createBaseReceipt();
  return {
    ...receipt,
    ...overrides,
    source_artifacts: {
      ...receipt.source_artifacts,
      ...(overrides.source_artifacts ?? {}),
    },
    approval: {
      ...receipt.approval,
      ...(overrides.approval ?? {}),
    },
    boundary: {
      ...receipt.boundary,
      ...(overrides.boundary ?? {}),
    },
    proof_summary: {
      ...receipt.proof_summary,
      ...(overrides.proof_summary ?? {}),
    },
    proof_refs: {
      ...receipt.proof_refs,
      ...(overrides.proof_refs ?? {}),
    },
    validation_context: {
      ...receipt.validation_context,
      ...(overrides.validation_context ?? {}),
    },
    source_refs: overrides.source_refs ?? receipt.source_refs,
  };
}

function receiptFileName(receiptId) {
  return `${receiptId.replaceAll(":", "-")}.json`;
}

async function seedReceipt({
  lifelineRoot,
  payload,
  pathSourceRepoId = payload.source_repo_id,
  pathTrancheId = payload.tranche_id,
  fileName = receiptFileName(payload.receipt_id ?? "receipt"),
}) {
  const receiptPath = path.join(
    getProofReferenceReceiptDestinationRoot(lifelineRoot),
    pathSourceRepoId,
    pathTrancheId,
    fileName,
  );
  await writeJson(receiptPath, payload);
  return receiptPath;
}

async function snapshotFiles(root) {
  const snapshot = new Map();

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
      snapshot.set(normalizePath(fullPath), await readFile(fullPath, "utf8"));
    }
  }

  await walk(root);
  return snapshot;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-proof-reference-index-"));
  const lifelineRoot = path.join(tempRoot, "repos", "fawxzzy-lifeline");
  const receiptsRoot = getProofReferenceReceiptDestinationRoot(lifelineRoot);

  try {
    const empty = await indexProofReferenceReceipts({ lifelineRoot });
    assert.equal(empty.receipt_count, 0);
    assert.equal(empty.valid_receipt_count, 0);
    assert.equal(empty.invalid_receipt_count, 0);
    assert.deepEqual(empty.receipts_by_source_repo_id, {});
    assert.deepEqual(empty.receipts_by_tranche_id, {});
    assert.deepEqual(empty.invalid_receipts, []);
    assert.deepEqual(empty.receipt_inventory, []);

    const validReceiptPath = await seedReceipt({
      lifelineRoot,
      payload: createBaseReceipt(),
    });
    const invalidSchemaReceipt = mergeReceipt({
      receipt_id: "sha256:missing-status",
    });
    delete invalidSchemaReceipt.status;
    const invalidSchemaReceiptPath = await seedReceipt({
      lifelineRoot,
      payload: invalidSchemaReceipt,
      fileName: "sha256-missing-status.json",
    });
    const autoApprovedReceiptPath = await seedReceipt({
      lifelineRoot,
      payload: mergeReceipt({
        receipt_id: "sha256:auto-approved",
        approval: {
          auto_approved: true,
        },
      }),
      pathSourceRepoId: "fitness",
      pathTrancheId: "F10",
    });
    const currentDebtReceiptPath = await seedReceipt({
      lifelineRoot,
      payload: mergeReceipt({
        receipt_id: "sha256:current-debt",
        tranche_id: "F09",
        validation_context: {
          current_validation_debt: ["observed critical=345, error=14, warning=181"],
        },
      }),
    });
    const missingBoundaryReceiptPath = await seedReceipt({
      lifelineRoot,
      payload: mergeReceipt({
        receipt_id: "sha256:missing-boundary",
        source_repo_id: "playbook",
        proof_summary: {
          owner_repo_id: "playbook",
        },
        tranche_id: "A02",
        boundary: {
          statement: "",
        },
      }),
    });

    const beforeSnapshot = await snapshotFiles(receiptsRoot);
    const indexed = await indexProofReferenceReceipts({ lifelineRoot });
    const afterSnapshot = await snapshotFiles(receiptsRoot);

    assert.deepEqual(afterSnapshot, beforeSnapshot, "indexer must not mutate receipts");
    assert.equal(indexed.receipt_count, 5);
    assert.equal(indexed.valid_receipt_count, 1);
    assert.equal(indexed.invalid_receipt_count, 4);
    assert.equal(indexed.proof_reference_count_total, 10);
    assert.deepEqual(indexed.receipts_by_source_repo_id, {
      fitness: [
        ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F10/sha256-auto-approved.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-missing-status.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-proof-reference-accepted-f11.json",
      ],
      playbook: [
        ".lifeline/receipts/proof-reference-accepted/playbook/A02/sha256-missing-boundary.json",
      ],
    });
    assert.deepEqual(indexed.receipts_by_tranche_id, {
      A02: [
        ".lifeline/receipts/proof-reference-accepted/playbook/A02/sha256-missing-boundary.json",
      ],
      F09: [
        ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
      ],
      F10: [
        ".lifeline/receipts/proof-reference-accepted/fitness/F10/sha256-auto-approved.json",
      ],
      F11: [
        ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-missing-status.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-proof-reference-accepted-f11.json",
      ],
    });
    assert.deepEqual(indexed.receipts_with_ambient_debt, [
      ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
      ".lifeline/receipts/proof-reference-accepted/fitness/F10/sha256-auto-approved.json",
      ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-missing-status.json",
      ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-proof-reference-accepted-f11.json",
      ".lifeline/receipts/proof-reference-accepted/playbook/A02/sha256-missing-boundary.json",
    ]);
    assert.deepEqual(indexed.receipts_with_current_validation_debt, [
      ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
    ]);
    assert.deepEqual(indexed.receipts_missing_boundary_statement, [
      ".lifeline/receipts/proof-reference-accepted/playbook/A02/sha256-missing-boundary.json",
    ]);
    assert.deepEqual(indexed.receipts_with_auto_approved_not_false, [
      ".lifeline/receipts/proof-reference-accepted/fitness/F10/sha256-auto-approved.json",
    ]);
    assert.deepEqual(
      indexed.invalid_receipts.map((entry) => entry.receipt_path),
      [
        ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F10/sha256-auto-approved.json",
        ".lifeline/receipts/proof-reference-accepted/fitness/F11/sha256-missing-status.json",
        ".lifeline/receipts/proof-reference-accepted/playbook/A02/sha256-missing-boundary.json",
      ],
      "invalid receipts should be reported deterministically",
    );
    assert(
      indexed.invalid_receipts[0].validation_errors.some((entry) =>
        entry.includes("$.validation_context.current_validation_debt must contain at most 0 item(s)."),
      ),
      "current validation debt receipts must be surfaced as invalid schema receipts",
    );
    assert(
      indexed.invalid_receipts[3].validation_errors.some((entry) =>
        entry.includes("$.boundary.statement must be at least 1 character(s)."),
      ),
      "missing boundary statement receipts must be surfaced as invalid schema receipts",
    );
    assert.equal(
      indexed.receipt_inventory[0].receipt_path,
      ".lifeline/receipts/proof-reference-accepted/fitness/F09/sha256-current-debt.json",
      "receipt inventory should be sorted deterministically by path",
    );

    const customAuditPath = path.join(
      lifelineRoot,
      ".lifeline",
      "audits",
      "custom-proof-reference-receipt-index.json",
    );
    const withArtifact = await indexProofReferenceReceipts({
      lifelineRoot,
      writeAuditArtifact: true,
      auditArtifactPath: customAuditPath,
    });
    assert.equal(withArtifact.audit_artifact_written, true);
    assert.equal(withArtifact.audit_artifact_path, normalizePath(customAuditPath));
    assert.deepEqual(
      JSON.parse(await readFile(customAuditPath, "utf8")),
      withArtifact,
      "audit artifact should mirror the deterministic stdout summary",
    );
    assert.deepEqual(
      await snapshotFiles(receiptsRoot),
      beforeSnapshot,
      "writing an audit artifact must still leave receipts unchanged",
    );

    const strippedEnv = { ...process.env };
    delete strippedEnv.GITHUB_TOKEN;
    delete strippedEnv.VERCEL_TOKEN;
    delete strippedEnv.OPENAI_API_KEY;
    const cliOutput = execFileSync(
      process.execPath,
      [indexScriptPath, "--lifeline-root", lifelineRoot],
      {
        cwd: repoRoot,
        env: strippedEnv,
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(cliOutput), indexed);
    assert.equal(
      getProofReferenceReceiptAuditArtifactPath(lifelineRoot),
      path.join(lifelineRoot, ".lifeline", "audits", "proof-reference-receipt-index.json"),
    );

    assert.equal(normalizePath(validReceiptPath).includes("\\"),
      false);
    assert.equal(normalizePath(invalidSchemaReceiptPath).includes("\\"),
      false);
    assert.equal(normalizePath(autoApprovedReceiptPath).includes("\\"),
      false);
    assert.equal(normalizePath(currentDebtReceiptPath).includes("\\"),
      false);
    assert.equal(normalizePath(missingBoundaryReceiptPath).includes("\\"),
      false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
