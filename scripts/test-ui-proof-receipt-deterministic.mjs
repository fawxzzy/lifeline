import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const distCli = path.join(repoRoot, "dist", "cli.js");

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveFixturePath(root, fileRef) {
  return path.isAbsolute(fileRef) ? fileRef : path.join(root, fileRef);
}

function parseReceiptPath(stdout) {
  const match = stdout.match(/Receipt written:\s*(.+)\s*$/m);
  return match ? match[1].trim() : null;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function runCli(args, atlasRoot) {
  const result = spawnSync("node", [distCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ATLAS_ROOT: atlasRoot,
      LIFELINE_ROOT: atlasRoot,
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function assertFailureSurface(result, expected) {
  assert.equal(
    result.status,
    1,
    `expected ${expected.name} to fail with exit 1, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(
    result.stderr,
    new RegExp(`Failure category: ${expected.category}`, "i"),
    `${expected.name} should report ${expected.category}:\n${result.stderr}`,
  );
  assert.match(
    result.stderr,
    /First remediation step:/i,
    `${expected.name} should include the first remediation step:\n${result.stderr}`,
  );
  assert(
    result.stderr.includes(expected.remediationIncludes),
    `${expected.name} should include remediation text ${expected.remediationIncludes}:\n${result.stderr}`,
  );
  if (expected.detailIncludes) {
    assert(
      result.stderr.includes(expected.detailIncludes),
      `${expected.name} should include detail ${expected.detailIncludes}:\n${result.stderr}`,
    );
  }
}

async function seedProofRoot(root, options = {}) {
  await writeFile(path.join(root, "stack.yaml"), "name: ATLAS\n", "utf8");

  const semanticRef =
    options.semanticRef ?? "runtime\\atlas\\ui-observe\\drift\\fitness\\latest.json";
  const visualRef =
    options.visualRef ?? "runtime\\atlas\\ui-visual-proof\\fitness\\latest.json";
  const summaryRef = options.summaryRef ?? "runtime\\atlas\\ui-proof\\fitness\\latest.json";

  if (options.writeSemanticReport !== false) {
    await writeJson(resolveFixturePath(root, semanticRef), {
      contract_version: "atlas.ui.drift-report.v1",
      report_id: "sha256:semantic-proof-clean",
      status: "clean",
      finding_count: 0,
      ...(options.semanticReport ?? {}),
    });
  }
  if (options.writeVisualReport !== false) {
    await writeJson(resolveFixturePath(root, visualRef), {
      contract_version: "atlas.ui.visual-proof.v1",
      report_id: "sha256:visual-proof-clean",
      status: "clean",
      gated_capture_count: 2,
      failed_capture_ids: [],
      ...(options.visualReport ?? {}),
    });
  }

  const summary = {
    contract_version: "atlas.ui.proof-summary.v1",
    report_id: "sha256:proof-summary-clean",
    generated_at: "2026-04-21T14:37:56.988018Z",
    runner_version: "atlas.ui.proof-summary.fitness.v1",
    owner_repo_id: "fitness",
    completion_ready: true,
    failed_capture_ids: [],
    blocking_reasons: [],
    summary: {
      status: "completion_ready",
      semantic_status: "clean",
      visual_status: "clean",
      gated_capture_count: 2,
      failed_capture_count: 0,
    },
    semantic_proof: {
      status: "clean",
      report_ref: semanticRef,
      report_id: "sha256:semantic-proof-clean",
      finding_count: 0,
      failed_capture_ids: [],
      errors: [],
    },
    visual_proof: {
      status: "clean",
      report_ref: visualRef,
      report_id: "sha256:visual-proof-clean",
      gated_capture_count: 2,
      failed_capture_ids: [],
      errors: [],
    },
    operator_summary: [
      "Semantic drift clean and visual proof clean across 2 gated captures.",
    ],
    ...(options.overrides ?? {}),
  };
  await writeJson(resolveFixturePath(root, summaryRef), summary);

  return {
    semanticRef,
    visualRef,
    summaryRef,
    summaryPath: resolveFixturePath(root, summaryRef),
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-ui-proof-"));
  try {
    const { summaryPath, semanticRef, visualRef } = await seedProofRoot(tempRoot);
    const successReceiptDir = path.join(tempRoot, "proof-receipts-success");
    const success = runCli(
      [
        "proof-pass",
        summaryPath,
        "--source-repo",
        "fitness",
        "--tranche",
        "F11",
        "--receipt-dir",
        successReceiptDir,
      ],
      tempRoot,
    );

    assert.equal(
      success.status,
      0,
      `expected successful proof-pass exit 0, got ${success.status}\n${success.stdout}\n${success.stderr}`,
    );
    const receiptPath = parseReceiptPath(success.stdout);
    assert(receiptPath, "proof-pass success did not print a receipt path");
    assert(!receiptPath.includes("\\"), "receipt path should be normalized");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.contract_version, "atlas.ui.proof-passed.receipt.v1");
    assert.equal(receipt.status, "proof_passed");
    assert.equal(receipt.source_repo_id, "fitness");
    assert.equal(receipt.tranche_id, "F11");
    assert.equal(
      receipt.proof_summary.summary_ref,
      "runtime/atlas/ui-proof/fitness/latest.json",
    );
    assert.equal(
      receipt.proof_refs.semantic_report_ref,
      "runtime/atlas/ui-observe/drift/fitness/latest.json",
    );
    assert.equal(
      receipt.proof_refs.visual_report_ref,
      "runtime/atlas/ui-visual-proof/fitness/latest.json",
    );
    assert.deepEqual(receipt.source_refs, [
      "runtime/atlas/ui-proof/fitness/latest.json",
      "runtime/atlas/ui-observe/drift/fitness/latest.json",
      "runtime/atlas/ui-visual-proof/fitness/latest.json",
    ]);

    const repeat = runCli(
      [
        "proof-pass",
        summaryPath,
        "--source-repo",
        "fitness",
        "--tranche",
        "F11",
        "--receipt-dir",
        successReceiptDir,
      ],
      tempRoot,
    );
    assert.equal(repeat.status, 0);
    const repeatReceiptPath = parseReceiptPath(repeat.stdout);
    assert.equal(repeatReceiptPath, receiptPath);
    const repeatReceipt = JSON.parse(await readFile(repeatReceiptPath, "utf8"));
    assert.equal(repeatReceipt.receipt_id, receipt.receipt_id);

    const absoluteRefRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-absolute-"),
    );
    try {
      const absoluteSemanticRef = path.join(
        absoluteRefRoot,
        "runtime",
        "atlas",
        "ui-observe",
        "drift",
        "fitness",
        "latest.json",
      );
      const absoluteVisualRef = path.join(
        absoluteRefRoot,
        "runtime",
        "atlas",
        "ui-visual-proof",
        "fitness",
        "latest.json",
      );
      const absoluteSeed = await seedProofRoot(absoluteRefRoot, {
        semanticRef: absoluteSemanticRef,
        visualRef: absoluteVisualRef,
      });
      const absoluteSuccess = runCli(
        [
          "proof-pass",
          absoluteSeed.summaryPath,
          "--source-repo",
          "fitness",
          "--tranche",
          "F12",
        ],
        absoluteRefRoot,
      );
      assert.equal(
        absoluteSuccess.status,
        0,
        `absolute ATLAS refs should still emit a receipt:\n${absoluteSuccess.stdout}\n${absoluteSuccess.stderr}`,
      );
      const absoluteReceiptPath = parseReceiptPath(absoluteSuccess.stdout);
      assert(absoluteReceiptPath, "absolute ref success did not print a receipt path");
      const absoluteReceipt = JSON.parse(
        await readFile(absoluteReceiptPath, "utf8"),
      );
      assert.equal(
        absoluteReceipt.proof_summary.summary_ref,
        "runtime/atlas/ui-proof/fitness/latest.json",
      );
      assert.equal(
        absoluteReceipt.proof_refs.semantic_report_ref,
        "runtime/atlas/ui-observe/drift/fitness/latest.json",
      );
      assert.equal(
        absoluteReceipt.proof_refs.visual_report_ref,
        "runtime/atlas/ui-visual-proof/fitness/latest.json",
      );
      assert.deepEqual(absoluteReceipt.source_refs, [
        "runtime/atlas/ui-proof/fitness/latest.json",
        "runtime/atlas/ui-observe/drift/fitness/latest.json",
        "runtime/atlas/ui-visual-proof/fitness/latest.json",
      ]);
      assert.equal(
        absoluteReceipt.proof_refs.semantic_report_ref.includes(":"),
        false,
        "absolute ATLAS refs should be rewritten to stack-relative refs",
      );
      assert.equal(
        absoluteReceipt.proof_refs.visual_report_ref.includes(":"),
        false,
        "absolute ATLAS refs should be rewritten to stack-relative refs",
      );
      assert.equal(
        absoluteReceipt.source_refs.some((entry) => entry.includes("\\")),
        false,
        "emitted source refs should stay slash-normalized",
      );
    } finally {
      await rm(absoluteRefRoot, { recursive: true, force: true });
    }

    const missingSummaryPath = path.join(
      tempRoot,
      "runtime",
      "atlas",
      "ui-proof",
      "fitness",
      "missing.json",
    );
    const missingSummary = runCli(
      [
        "proof-pass",
        missingSummaryPath,
        "--source-repo",
        "fitness",
        "--tranche",
        "F11",
      ],
      tempRoot,
    );
    assertFailureSurface(missingSummary, {
      name: "missing summary",
      category: "environment_error",
      remediationIncludes:
        "Verify the proof summary path and the referenced proof reports are readable, then rerun.",
      detailIncludes: normalizePath(missingSummaryPath),
    });

    const missingSemanticRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-missing-semantic-"),
    );
    try {
      const missingSemanticSeed = await seedProofRoot(missingSemanticRoot, {
        semanticRef: "runtime\\atlas\\ui-observe\\drift\\fitness\\missing.json",
        writeSemanticReport: false,
      });
      const missingSemantic = runCli(
        [
          "proof-pass",
          missingSemanticSeed.summaryPath,
          "--source-repo",
          "fitness",
          "--tranche",
          "F11",
        ],
        missingSemanticRoot,
      );
      assertFailureSurface(missingSemantic, {
        name: "missing semantic proof report",
        category: "environment_error",
        remediationIncludes:
          "Verify the proof summary path and the referenced proof reports are readable, then rerun.",
        detailIncludes: "runtime/atlas/ui-observe/drift/fitness/missing.json",
      });
    } finally {
      await rm(missingSemanticRoot, { recursive: true, force: true });
    }

    const malformedSummaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-malformed-"),
    );
    try {
      const malformedSeed = await seedProofRoot(malformedSummaryRoot);
      await writeFile(
        malformedSeed.summaryPath,
        "{ not-valid-json }\n",
        "utf8",
      );
      const malformedSummary = runCli(
        [
          "proof-pass",
          malformedSeed.summaryPath,
          "--source-repo",
          "fitness",
          "--tranche",
          "F11",
        ],
        malformedSummaryRoot,
      );
      assertFailureSurface(malformedSummary, {
        name: "malformed summary",
        category: "config_error",
        remediationIncludes:
          "Fix the proof summary, source repo, or tranche arguments so they match the ATLAS proof contract, then rerun.",
        detailIncludes: "Could not parse JSON",
      });
    } finally {
      await rm(malformedSummaryRoot, { recursive: true, force: true });
    }

    const mismatchedOwnerRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-owner-mismatch-"),
    );
    try {
      const mismatchedOwnerSeed = await seedProofRoot(mismatchedOwnerRoot);
      const mismatchedOwner = runCli(
        [
          "proof-pass",
          mismatchedOwnerSeed.summaryPath,
          "--source-repo",
          "mazer",
          "--tranche",
          "F11",
        ],
        mismatchedOwnerRoot,
      );
      assertFailureSurface(mismatchedOwner, {
        name: "owner mismatch",
        category: "config_error",
        remediationIncludes:
          "Fix the proof summary, source repo, or tranche arguments so they match the ATLAS proof contract, then rerun.",
        detailIncludes: "does not match proof summary owner_repo_id",
      });
    } finally {
      await rm(mismatchedOwnerRoot, { recursive: true, force: true });
    }

    const semanticBlockedRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-semantic-"),
    );
    try {
      const semanticSeed = await seedProofRoot(semanticBlockedRoot, {
        overrides: {
          completion_ready: true,
          blocking_reasons: ["semantic drift detected"],
          summary: {
            status: "proof_blocked",
            semantic_status: "drift_detected",
            visual_status: "clean",
            gated_capture_count: 2,
            failed_capture_count: 1,
          },
          semantic_proof: {
            status: "drift_detected",
            report_ref: "runtime/atlas/ui-observe/drift/fitness/latest.json",
            report_id: "sha256:semantic-proof-drift",
            finding_count: 1,
            failed_capture_ids: ["curated-onboarding-shell"],
            errors: [],
          },
        },
      });
      const semanticBlocked = runCli(
        [
          "proof-pass",
          semanticSeed.summaryPath,
          "--source-repo",
          "fitness",
          "--tranche",
          "F11",
        ],
        semanticBlockedRoot,
      );
      assertFailureSurface(semanticBlocked, {
        name: "semantic proof blocked",
        category: "config_error",
        remediationIncludes:
          "Fix the proof summary, source repo, or tranche arguments so they match the ATLAS proof contract, then rerun.",
        detailIncludes: "does not have clean semantic proof",
      });
    } finally {
      await rm(semanticBlockedRoot, { recursive: true, force: true });
    }

    const visualBlockedRoot = await mkdtemp(
      path.join(os.tmpdir(), "lifeline-ui-proof-visual-"),
    );
    try {
      const visualSeed = await seedProofRoot(visualBlockedRoot, {
        overrides: {
          completion_ready: true,
          blocking_reasons: ["visual proof failed"],
          summary: {
            status: "proof_blocked",
            semantic_status: "clean",
            visual_status: "proof_failed",
            gated_capture_count: 2,
            failed_capture_count: 1,
          },
          visual_proof: {
            status: "proof_failed",
            report_ref: "runtime/atlas/ui-visual-proof/fitness/latest.json",
            report_id: "sha256:visual-proof-failed",
            gated_capture_count: 2,
            failed_capture_ids: ["today-overview-default"],
            errors: ["unexpected visual delta"],
          },
        },
      });
      const visualBlocked = runCli(
        [
          "proof-pass",
          visualSeed.summaryPath,
          "--source-repo",
          "fitness",
          "--tranche",
          "F11",
        ],
        visualBlockedRoot,
      );
      assertFailureSurface(visualBlocked, {
        name: "visual proof blocked",
        category: "config_error",
        remediationIncludes:
          "Fix the proof summary, source repo, or tranche arguments so they match the ATLAS proof contract, then rerun.",
        detailIncludes: "does not have clean visual proof",
      });
    } finally {
      await rm(visualBlockedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
