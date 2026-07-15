#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROADMAP_PATH = "docs/roadmap/LIFELINE_ROADMAP.json";
const ATLAS_ROADMAP_PATH = "repos/lifeline/docs/roadmap/LIFELINE_ROADMAP.json";
const DEFAULT_OUTPUT_PATH = "exports/lifeline.project-board.owner-export.v1.json";
const BOARD_ID = "discordos:project-feedback:lifeline";
const STATUS_MAPPING = new Map([
  ["in-progress", { recordStatus: "active", lifecycle: "in-progress" }],
  ["planned", { recordStatus: "active", lifecycle: "planning" }],
  ["candidate", { recordStatus: "candidate", lifecycle: "intake" }],
  ["planned-later", { recordStatus: "candidate", lifecycle: "intake" }],
  ["blocked", { recordStatus: "active", lifecycle: "blocked" }]
]);
const CARD_TYPES = new Set([
  "feature", "bug", "governance", "architecture", "documentation",
  "automation", "research", "migration", "reliability", "technical-debt"
]);

const uniqueSorted = (values) => [...new Set(values)].sort((left, right) => left.localeCompare(right));
const atlasPath = (value) => `repos/lifeline/${value.replaceAll("\\", "/")}`;

function normalizeTimestamp(value) {
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(candidate);
  if (!candidate || Number.isNaN(parsed.getTime())) throw new Error("roadmap.updatedAt must be an ISO date or date-time");
  return parsed.toISOString();
}

function stringArray(item, field, allowEmpty = true) {
  if (!Array.isArray(item[field]) || item[field].some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error(`${item.id ?? "<unknown>"}.${field} must be an array of non-empty strings`);
  }
  if (!allowEmpty && item[field].length === 0) throw new Error(`${item.id}.${field} must not be empty`);
  return item[field];
}

function mapItem(item, generatedAt) {
  const mapping = STATUS_MAPPING.get(item.status);
  if (!mapping) throw new Error(`unsupported non-complete roadmap status for ${item.id}: ${JSON.stringify(item.status)}`);
  if (typeof item.id !== "string" || !/^LIF-[A-Z0-9-]+$/.test(item.id)) throw new Error("work item id must use the LIF-* format");
  if (typeof item.title !== "string" || item.title.trim() === "") throw new Error(`${item.id}.title is required`);
  if (typeof item.goal !== "string" || item.goal.trim() === "") throw new Error(`${item.id}.goal is required`);
  if (!CARD_TYPES.has(item.type)) throw new Error(`${item.id}.type is not supported`);
  if (item.priority !== null) throw new Error(`${item.id}.priority must remain null until owner prioritization is explicit`);
  const sourceRef = `${ATLAS_ROADMAP_PATH}#${item.id}`;
  const normalizedId = item.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dependencies = uniqueSorted(stringArray(item, "dependencies"));

  return {
    idempotency_key: `pbk_lifeline_${normalizedId}_v1`,
    record_kind: "project-work",
    record_status: mapping.recordStatus,
    record: {
      contract_version: "atlas.card-record.v2",
      card_id: item.id,
      project_id: "lifeline",
      board_id: BOARD_ID,
      title: item.title,
      description: item.goal,
      card_type: item.type,
      lifecycle: mapping.lifecycle,
      priority: null,
      owner: "lifeline",
      dependencies,
      board_version: 1,
      updated_at: generatedAt,
      source_ref: sourceRef,
      extensions: { roadmap_status: item.status, roadmap_schema_version: 1 }
    },
    source: {
      source_id: "lifeline-roadmap",
      source_ref: sourceRef,
      source_status: "current",
      source_updated_at: generatedAt
    },
    content: {
      summary: item.goal,
      objective: item.goal,
      acceptance_criteria: stringArray(item, "acceptanceCriteria", false),
      discoveries: [],
      next_actions: [],
      blockers: item.status === "blocked" ? dependencies.map((dependency) => `Blocked by ${dependency}.`) : [],
      evidence: uniqueSorted(stringArray(item, "evidence").map(atlasPath))
    },
    relationships: { parent_card_id: null, duplicate_of: null, superseded_by: null }
  };
}

export function buildProjectBoardOwnerExport(roadmap, roadmapBytes) {
  if (!roadmap || roadmap.schemaVersion !== 1 || roadmap.projectId !== "lifeline") throw new Error("unexpected Lifeline roadmap identity");
  if (!Array.isArray(roadmap.workItems) || roadmap.workItems.length === 0) throw new Error("roadmap.workItems must not be empty");
  const ids = roadmap.workItems.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("roadmap work item ids must be unique");
  const generatedAt = normalizeTimestamp(roadmap.updatedAt);
  const normalizedBytes = Buffer.from(roadmapBytes).toString("utf8").replace(/\r\n?/g, "\n");
  const digest = crypto.createHash("sha256").update(normalizedBytes, "utf8").digest("hex");
  const sourceRevision = `sha256:${digest}`;
  const cards = roadmap.workItems
    .filter((item) => item.status !== "complete")
    .map((item) => mapItem(item, generatedAt))
    .sort((left, right) => left.record.card_id.localeCompare(right.record.card_id));

  return {
    contract_version: "atlas.project-board.owner-export.v1",
    export_id: `pbe_lifeline_roadmap_${digest.slice(0, 12)}`,
    project_id: "lifeline",
    board_id: BOARD_ID,
    owner: "lifeline",
    adapter_id: "lifeline-roadmap-v1",
    source_revision: sourceRevision,
    generated_at: generatedAt,
    sources: [{
      source_id: "lifeline-roadmap",
      kind: "json",
      repository: "lifeline",
      path: ATLAS_ROADMAP_PATH,
      revision: sourceRevision,
      observed_at: generatedAt
    }],
    cards,
    extensions: {
      source_digest: sourceRevision,
      source_work_item_count: roadmap.workItems.length,
      exported_card_count: cards.length,
      excluded_completed_statuses: ["complete"],
      discord_mutation_authorized: false,
      empty_playbook_plan_classification: "verification-output-not-product-roadmap"
    }
  };
}

export function renderProjectBoardOwnerExport(repoRoot) {
  const bytes = fs.readFileSync(path.join(repoRoot, ROADMAP_PATH));
  return `${JSON.stringify(buildProjectBoardOwnerExport(JSON.parse(bytes.toString("utf8")), bytes), null, 2)}\n`;
}

export function runProjectBoardOwnerExport(argv, repoRoot = process.cwd()) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  const rendered = renderProjectBoardOwnerExport(repoRoot);
  const outputPath = path.join(repoRoot, DEFAULT_OUTPUT_PATH);
  if (check) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== rendered) {
      throw new Error(`${DEFAULT_OUTPUT_PATH} is stale; run pnpm board:export`);
    }
    process.stdout.write(`lifeline-project-board-owner-export: ok (${JSON.parse(rendered).cards.length} cards)\n`);
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered, "utf8");
  process.stdout.write(`lifeline-project-board-owner-export: wrote ${DEFAULT_OUTPUT_PATH}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runProjectBoardOwnerExport(process.argv.slice(2));
  } catch (error) {
    console.error(`lifeline-project-board-owner-export: ${error.message}`);
    process.exitCode = 1;
  }
}
