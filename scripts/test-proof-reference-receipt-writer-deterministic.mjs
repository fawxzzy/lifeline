import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PROOF_REFERENCE_RECEIPT_RUNNER_VERSION,
  getProofReferenceReceiptDestinationRoot,
  writeProofReferenceReceipt,
} from "./write-proof-reference-receipt.mjs";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function createBaseCandidate() {
  return {
    contract_version: "atlas.lifeline.proof-reference.receipt.v1",
    receipt_id: "sha256:proof-reference-accepted-f11",
    emitted_at: "2026-04-28T18:42:00.000Z",
    runner_version: "cortex.lifeline-receipt-payload.v1",
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
      approved_at: "2026-04-28T18:42:00.000Z",
      reviewer_label: "Lane T reviewer",
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

function mergeCandidate(overrides) {
  const candidate = createBaseCandidate();
  return {
    ...candidate,
    ...overrides,
    source_artifacts: {
      ...candidate.source_artifacts,
      ...(overrides.source_artifacts ?? {}),
    },
    approval: {
      ...candidate.approval,
      ...(overrides.approval ?? {}),
    },
    boundary: {
      ...candidate.boundary,
      ...(overrides.boundary ?? {}),
    },
    proof_summary: {
      ...candidate.proof_summary,
      ...(overrides.proof_summary ?? {}),
    },
    proof_refs: {
      ...candidate.proof_refs,
      ...(overrides.proof_refs ?? {}),
    },
    validation_context: {
      ...candidate.validation_context,
      ...(overrides.validation_context ?? {}),
    },
  };
}

async function seedCandidate(root, payload) {
  await writeFile(path.join(root, "stack.yaml"), "name: ATLAS\n", "utf8");
  const candidatePath = path.join(
    root,
    "runtime",
    "cortex",
    "lifeline-receipt-candidates",
    "runs",
    `${payload.receipt_id?.replaceAll(":", "-") ?? "candidate"}.json`,
  );
  await writeJson(candidatePath, payload);
  return candidatePath;
}

async function listFiles(root) {
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      files.push(normalizePath(fullPath));
    }
  }

  try {
    await walk(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return files.sort();
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-proof-reference-writer-"));
  const lifelineRoot = path.join(tempRoot, "repos", "fawxzzy-lifeline");
  const destinationRoot = getProofReferenceReceiptDestinationRoot(lifelineRoot);

  try {
    const successCandidatePath = await seedCandidate(tempRoot, createBaseCandidate());
    const success = await writeProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
    });
    assert.equal(success.blocked, false);
    assert.equal(success.receipt_written, true);
    assert.equal(success.reviewer_label, "Lane T reviewer");
    assert.equal(success.auto_approved, false);
    assert.equal(success.proof_reference_count, 2);
    assert.equal(
      success.owner_boundary_statement,
      createBaseCandidate().boundary.statement,
    );
    assert(success.receipt_path, "success should return a receipt path");
    assert.equal(success.receipt_path.includes("\\"), false);

    const receipt = JSON.parse(await readFile(success.receipt_path, "utf8"));
    assert.equal(receipt.contract_version, "atlas.lifeline.proof-reference.receipt.v1");
    assert.equal(receipt.runner_version, PROOF_REFERENCE_RECEIPT_RUNNER_VERSION);
    assert.equal(receipt.approval.explicit_human_approval, true);
    assert.equal(receipt.approval.auto_approved, false);
    assert.equal(
      normalizePath(success.receipt_path).startsWith(normalizePath(destinationRoot)),
      true,
      "receipt should stay inside the Lifeline-owned destination",
    );
    assert.deepEqual(await listFiles(destinationRoot), [normalizePath(success.receipt_path)]);

    const repeat = await writeProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
    });
    assert.equal(repeat.blocked, false);
    assert.equal(repeat.receipt_path, success.receipt_path);
    const repeatedReceipt = JSON.parse(await readFile(repeat.receipt_path, "utf8"));
    assert.deepEqual(repeatedReceipt, receipt);
    assert.deepEqual(await listFiles(destinationRoot), [normalizePath(success.receipt_path)]);

    const noApprovalCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:no-approval",
        approval: {
          explicit_human_approval: false,
        },
      }),
    );
    const noApproval = await writeProofReferenceReceipt({
      candidatePath: noApprovalCandidatePath,
      lifelineRoot,
    });
    assert.equal(noApproval.blocked, true);
    assert.equal(noApproval.blocked_reason, "missing_explicit_human_approval");
    assert.equal(noApproval.receipt_written, false);

    const autoApprovedCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:auto-approved",
        approval: {
          auto_approved: true,
        },
      }),
    );
    const autoApproved = await writeProofReferenceReceipt({
      candidatePath: autoApprovedCandidatePath,
      lifelineRoot,
    });
    assert.equal(autoApproved.blocked, true);
    assert.equal(autoApproved.blocked_reason, "auto_approval_forbidden");
    assert.equal(autoApproved.receipt_written, false);

    const debtCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:current-debt",
        validation_context: {
          current_validation_debt: ["observed critical=345, error=14, warning=183"],
        },
      }),
    );
    const debtBlocked = await writeProofReferenceReceipt({
      candidatePath: debtCandidatePath,
      lifelineRoot,
    });
    assert.equal(debtBlocked.blocked, true);
    assert.equal(debtBlocked.blocked_reason, "current_validation_debt_present");
    assert.equal(debtBlocked.receipt_written, false);

    const missingProofRefCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:missing-proof-ref",
        source_refs: [
          "runtime/cortex/proof-reference-packs/runs/cortex-run-result.latest.json",
          "runtime/cortex/lifeline-write-ready/runs/cortex-run-result.latest.json",
          "runtime/atlas/ui-proof/fitness/latest.json",
          "runtime/atlas/ui-observe/drift/fitness/latest.json",
        ],
      }),
    );
    const missingProofRef = await writeProofReferenceReceipt({
      candidatePath: missingProofRefCandidatePath,
      lifelineRoot,
    });
    assert.equal(missingProofRef.blocked, true);
    assert.equal(missingProofRef.blocked_reason, "missing_required_proof_refs");
    assert.equal(missingProofRef.receipt_written, false);

    const missingBoundaryCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:missing-boundary",
        boundary: {
          statement: "",
        },
      }),
    );
    const missingBoundary = await writeProofReferenceReceipt({
      candidatePath: missingBoundaryCandidatePath,
      lifelineRoot,
    });
    assert.equal(missingBoundary.blocked, true);
    assert.equal(missingBoundary.blocked_reason, "missing_owner_boundary_statement");
    assert.equal(missingBoundary.receipt_written, false);

    const schemaInvalidCandidate = createBaseCandidate();
    delete schemaInvalidCandidate.receipt_id;
    const schemaInvalidCandidatePath = await seedCandidate(tempRoot, schemaInvalidCandidate);
    const schemaInvalid = await writeProofReferenceReceipt({
      candidatePath: schemaInvalidCandidatePath,
      lifelineRoot,
    });
    assert.equal(schemaInvalid.blocked, true);
    assert.equal(schemaInvalid.blocked_reason, "schema_validation_failed");
    assert.equal(schemaInvalid.receipt_written, false);

    const escapedDestinationCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:unsafe-destination",
        source_repo_id: "../escape",
        proof_summary: {
          owner_repo_id: "../escape",
        },
      }),
    );
    const escapedDestination = await writeProofReferenceReceipt({
      candidatePath: escapedDestinationCandidatePath,
      lifelineRoot,
    });
    assert.equal(escapedDestination.blocked, true);
    assert.equal(escapedDestination.blocked_reason, "unsafe_receipt_destination");
    assert.equal(escapedDestination.receipt_written, false);

    assert.deepEqual(
      await listFiles(destinationRoot),
      [normalizePath(success.receipt_path)],
      "blocked writes must not create extra receipt artifacts",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
