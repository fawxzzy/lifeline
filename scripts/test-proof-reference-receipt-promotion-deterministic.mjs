import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { promoteProofReferenceReceipt } from "./promote-proof-reference-receipt.mjs";
import { getProofReferenceReceiptDestinationRoot } from "./write-proof-reference-receipt.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const promotionScriptPath = path.join(
  repoRoot,
  "scripts",
  "promote-proof-reference-receipt.mjs",
);
const promotionPolicyDocPath = path.join(
  repoRoot,
  "docs",
  "contracts",
  "proof-reference-receipt-promotion-policy.md",
);

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
    receipt_id: "sha256:proof-reference-accepted-x11",
    emitted_at: "2026-04-28T19:14:00.000Z",
    runner_version: "cortex.lifeline-receipt-payload.v1",
    status: "proof_reference_accepted",
    source_repo_id: "fitness",
    tranche_id: "X11",
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
      approved_at: "2026-04-28T19:14:00.000Z",
      reviewer_label: "Lane X reviewer",
      approval_note:
        "Explicit human approval recorded after reviewing the dry-run, proof-reference pack, and Lifeline contract.",
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
    source_refs: overrides.source_refs ?? candidate.source_refs,
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

function assertBlocked(result, code) {
  assert.equal(result.promoted, false);
  assert.equal(result.receipt_written, false);
  assert.equal(result.blocked, true);
  assert.equal(result.blocked_reason, code);
  assert(result.blocker_codes.includes(code), `expected blocker ${code}`);
}

async function main() {
  const policyDoc = await readFile(promotionPolicyDocPath, "utf8");
  assert(
    policyDoc.includes(
      "A production receipt promotion may write exactly one final Lifeline receipt only when production intent, explicit human approval, dry-run success, schema validity, zero current validation debt, and path safety all pass together.",
    ) &&
      policyDoc.includes(
        "Dry-run proves the target; promotion performs the write through the existing Lifeline-owned writer without adding new receipt truth.",
      ) &&
      policyDoc.includes(
        "Do not let production_promotion_requested, human approval metadata, or dry-run success individually imply approval; all gates must pass together.",
      ),
    "promotion policy doc should include the Lane X Rule, Pattern, and Failure Mode summary",
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-proof-reference-promotion-"));
  const lifelineRoot = path.join(tempRoot, "repos", "fawxzzy-lifeline");
  const destinationRoot = getProofReferenceReceiptDestinationRoot(lifelineRoot);

  try {
    const successCandidatePath = await seedCandidate(tempRoot, createBaseCandidate());
    const success = await promoteProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });

    assert.equal(success.promoted, true);
    assert.equal(success.receipt_written, true);
    assert.equal(success.blocked, false);
    assert.equal(success.blocked_reason, null);
    assert.equal(success.dry_run_passed, true);
    assert.equal(success.production_promotion_requested, true);
    assert.equal(success.explicit_human_approval, true);
    assert.equal(success.auto_approved, false);
    assert.equal(success.proof_reference_count, 2);
    assert.equal(
      success.owner_boundary_statement,
      createBaseCandidate().boundary.statement,
    );
    assert.equal(
      success.receipt_path,
      normalizePath(
        path.join(
          lifelineRoot,
          ".lifeline",
          "receipts",
          "proof-reference-accepted",
          "fitness",
          "X11",
          "sha256-proof-reference-accepted-x11.json",
        ),
      ),
    );
    assert.deepEqual(await listFiles(destinationRoot), [success.receipt_path]);

    const receipt = JSON.parse(await readFile(success.receipt_path, "utf8"));
    assert.equal(receipt.approval.explicit_human_approval, true);
    assert.equal(receipt.approval.auto_approved, false);

    const repeated = await promoteProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assert.deepEqual(repeated, success, "promotion output should be deterministic");
    assert.deepEqual(
      await listFiles(destinationRoot),
      [success.receipt_path],
      "promotion should not write outside the canonical receipt destination",
    );

    const strippedEnv = { ...process.env };
    delete strippedEnv.GITHUB_TOKEN;
    delete strippedEnv.VERCEL_TOKEN;
    delete strippedEnv.OPENAI_API_KEY;
    const cliOutput = execFileSync(
      process.execPath,
      [
        promotionScriptPath,
        successCandidatePath,
        "--lifeline-root",
        lifelineRoot,
        "--production-promotion-requested",
      ],
      {
        cwd: repoRoot,
        env: strippedEnv,
        encoding: "utf8",
      },
    );
    assert.equal(cliOutput, `${JSON.stringify(success, null, 2)}\n`);

    const missingIntent = await promoteProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
      productionPromotionRequested: false,
    });
    assertBlocked(missingIntent, "production_promotion_not_requested");

    const dryRunBlocked = await promoteProofReferenceReceipt({
      candidatePath: successCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
      dryRunTestReceiptPassed: false,
    });
    assertBlocked(dryRunBlocked, "isolated_roundtrip_not_confirmed");

    const missingApprovalCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:missing-approval",
        approval: {
          explicit_human_approval: false,
        },
      }),
    );
    const missingApproval = await promoteProofReferenceReceipt({
      candidatePath: missingApprovalCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(missingApproval, "missing_explicit_human_approval");

    const autoApprovedCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:auto-approved",
        approval: {
          auto_approved: true,
        },
      }),
    );
    const autoApproved = await promoteProofReferenceReceipt({
      candidatePath: autoApprovedCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(autoApproved, "auto_approval_forbidden");

    const currentDebtCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:current-debt",
        validation_context: {
          current_validation_debt: ["observed critical=345, error=14, warning=181"],
        },
      }),
    );
    const currentDebt = await promoteProofReferenceReceipt({
      candidatePath: currentDebtCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(currentDebt, "current_validation_debt_present");

    const missingProofRefsCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:missing-proof-refs",
        source_refs: [
          "runtime/cortex/proof-reference-packs/runs/cortex-run-result.latest.json",
          "runtime/cortex/lifeline-write-ready/runs/cortex-run-result.latest.json",
          "runtime/atlas/ui-proof/fitness/latest.json",
          "runtime/atlas/ui-observe/drift/fitness/latest.json",
        ],
      }),
    );
    const missingProofRefs = await promoteProofReferenceReceipt({
      candidatePath: missingProofRefsCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(missingProofRefs, "missing_required_proof_refs");

    const unsafeDestinationCandidatePath = await seedCandidate(
      tempRoot,
      mergeCandidate({
        receipt_id: "sha256:unsafe-destination",
        source_repo_id: "../escape",
        proof_summary: {
          owner_repo_id: "../escape",
        },
      }),
    );
    const unsafeDestination = await promoteProofReferenceReceipt({
      candidatePath: unsafeDestinationCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(unsafeDestination, "unsafe_receipt_destination");
    assert.equal(unsafeDestination.receipt_path, null);

    const schemaInvalidCandidate = createBaseCandidate();
    delete schemaInvalidCandidate.receipt_id;
    const schemaInvalidCandidatePath = await seedCandidate(tempRoot, schemaInvalidCandidate);
    const schemaInvalid = await promoteProofReferenceReceipt({
      candidatePath: schemaInvalidCandidatePath,
      lifelineRoot,
      productionPromotionRequested: true,
    });
    assertBlocked(schemaInvalid, "schema_validation_failed");

    assert.deepEqual(
      await listFiles(destinationRoot),
      [success.receipt_path],
      "blocked promotions must not create extra receipt artifacts",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
