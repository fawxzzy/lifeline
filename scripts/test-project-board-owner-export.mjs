import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProjectBoardOwnerExport, renderProjectBoardOwnerExport, runProjectBoardOwnerExport } from "./export-project-board-owner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roadmapPath = path.join(root, "docs/roadmap/LIFELINE_ROADMAP.json");
const roadmapBytes = fs.readFileSync(roadmapPath);
const roadmap = JSON.parse(roadmapBytes.toString("utf8"));

test("exports only the remaining honest Lifeline owner lanes", () => {
  const output = buildProjectBoardOwnerExport(roadmap, roadmapBytes);
  assert.equal(roadmap.workItems.length, 12);
  assert.deepEqual(output.cards.map((card) => card.record.card_id), [
    "LIF-202",
    "LIF-203",
    "LIF-204",
  ]);
  assert.deepEqual(
    output.cards.map((card) => card.record_status),
    ["candidate", "active", "active"],
  );
  assert.deepEqual(
    output.cards.map((card) => card.record.lifecycle),
    ["intake", "planning", "planning"],
  );
  assert.ok(output.cards.every((card) => card.record.priority === null));
  assert.equal(output.extensions.discord_mutation_authorized, false);
  assert.equal(output.extensions.empty_playbook_plan_classification, "verification-output-not-product-roadmap");
});

test("preserves owner boundaries and ATLAS-relative evidence", () => {
  const output = buildProjectBoardOwnerExport(roadmap, roadmapBytes);
  assert.ok(output.cards.every((card) => card.record.owner === "lifeline"));
  assert.ok(output.cards.every((card) => card.content.evidence.every((ref) => ref.startsWith("repos/lifeline/"))));
  assert.equal(output.cards.find((card) => card.record.card_id === "LIF-202").record.dependencies[0], "LIF-201");
  assert.equal(output.cards.find((card) => card.record.card_id === "LIF-203").record.dependencies[0], "LIF-201");
  assert.equal(output.cards.find((card) => card.record.card_id === "LIF-204").record.dependencies[0], "LIF-203");
});

test("normalizes CRLF before hashing", () => {
  const normalized = roadmapBytes.toString("utf8").replace(/\r\n?/g, "\n");
  const lf = buildProjectBoardOwnerExport(roadmap, Buffer.from(normalized));
  const crlf = buildProjectBoardOwnerExport(roadmap, Buffer.from(normalized.replace(/\n/g, "\r\n")));
  assert.equal(lf.source_revision, crlf.source_revision);
});

test("rejects duplicate identities and invented priority", () => {
  const duplicate = structuredClone(roadmap);
  duplicate.workItems[1].id = duplicate.workItems[0].id;
  assert.throws(() => buildProjectBoardOwnerExport(duplicate, Buffer.from(JSON.stringify(duplicate))), /ids must be unique/);
  const prioritized = structuredClone(roadmap);
  prioritized.workItems.find((item) => item.id === "LIF-202").priority = "high";
  assert.throws(() => buildProjectBoardOwnerExport(prioritized, Buffer.from(JSON.stringify(prioritized))), /priority must remain null/);
});

test("check mode detects output drift", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-owner-export-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "docs/roadmap"), { recursive: true });
    fs.copyFileSync(roadmapPath, path.join(tempRoot, "docs/roadmap/LIFELINE_ROADMAP.json"));
    runProjectBoardOwnerExport([], tempRoot);
    assert.doesNotThrow(() => runProjectBoardOwnerExport(["--check"], tempRoot));
    fs.writeFileSync(path.join(tempRoot, "exports/lifeline.project-board.owner-export.v1.json"), "{}\n");
    assert.throws(() => runProjectBoardOwnerExport(["--check"], tempRoot), /is stale/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("committed export matches deterministic rendering", () => {
  const expected = renderProjectBoardOwnerExport(root);
  const actual = fs.readFileSync(path.join(root, "exports/lifeline.project-board.owner-export.v1.json"), "utf8");
  assert.equal(actual, expected);
});
