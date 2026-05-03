import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const docsPath = path.join(
  repoRoot,
  "docs",
  "contracts",
  "proof-reference-receipt-contract.md",
);
const schemaPath = path.join(
  repoRoot,
  "schemas",
  "proof-reference-receipt.schema.json",
);
const fixturePath = path.join(
  repoRoot,
  "fixtures",
  "contracts",
  "proof-reference-receipt.example.json",
);

function readJson(filePath) {
  return readFile(filePath, "utf8").then((content) => JSON.parse(content));
}

const [docs, schema, fixture] = await Promise.all([
  readFile(docsPath, "utf8"),
  readJson(schemaPath),
  readJson(fixturePath),
]);

assert.equal(
  schema.properties.contract_version.const,
  "atlas.lifeline.proof-reference.receipt.v1",
);
assert.equal(schema.properties.status.const, "proof_reference_accepted");
assert.deepEqual(schema.required, [
  "contract_version",
  "receipt_id",
  "emitted_at",
  "runner_version",
  "status",
  "source_repo_id",
  "tranche_id",
  "source_artifacts",
  "approval",
  "boundary",
  "proof_summary",
  "proof_refs",
  "source_refs",
  "validation_context",
]);

assert.equal(
  fixture.contract_version,
  "atlas.lifeline.proof-reference.receipt.v1",
);
assert.equal(fixture.status, "proof_reference_accepted");
assert.equal(fixture.source_repo_id, fixture.proof_summary.owner_repo_id);
assert.equal(fixture.approval.explicit_human_approval, true);
assert.equal(fixture.approval.auto_approved, false);
assert(
  fixture.approval.reviewer_id || fixture.approval.reviewer_label,
  "fixture approval must carry reviewer identity",
);
assert.equal(fixture.boundary.final_receipt_owner, "lifeline");
assert.equal(fixture.boundary.prepared_by, "cortex");
assert(
  fixture.boundary.statement.includes("Lifeline owns final receipt truth"),
  "boundary statement must preserve Lifeline ownership",
);
assert.deepEqual(fixture.validation_context.current_validation_debt, []);
assert(
  fixture.validation_context.known_ambient_debt.length >= 1,
  "fixture should preserve ambient debt as audit context",
);

const requiredSourceRefs = [
  fixture.source_artifacts.proof_reference_pack_ref,
  fixture.source_artifacts.write_ready_artifact_ref,
  fixture.proof_summary.summary_ref,
  fixture.proof_refs.semantic_report_ref,
  fixture.proof_refs.visual_report_ref,
];
assert.deepEqual(
  fixture.source_refs,
  requiredSourceRefs,
  "source_refs must be the normalized union of required proof-reference inputs",
);
assert.equal(
  fixture.source_refs.some((entry) => entry.includes("\\")),
  false,
  "source_refs must stay slash-normalized",
);

assert.ok(
  docs.includes("atlas.lifeline.proof-reference.receipt.v1") &&
    docs.includes("explicit_human_approval") &&
    docs.includes("auto_approved") &&
    docs.includes("known_ambient_debt") &&
    docs.includes("current_validation_debt") &&
    docs.includes("write_ready_artifact_ref") &&
    docs.includes("boundary.statement") &&
    docs.includes(".lifeline/receipts/proof-reference-accepted/") &&
    docs.includes("lifeline.proof-reference-receipt.v1"),
  "proof-reference contract doc should describe the owner-side receipt fields and boundary rules",
);
assert.ok(
  docs.includes("Lane U proved the isolated end-to-end roundtrip") &&
    docs.includes("Lane V defines the production promotion policy"),
  "proof-reference contract doc should describe the isolated roundtrip boundary and promotion-policy follow-up",
);

console.log("Proof-reference receipt contract deterministic checks passed");
