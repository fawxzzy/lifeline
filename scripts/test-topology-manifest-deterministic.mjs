import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const atlasRoot = path.resolve(repoRoot, "..", "..");
const topologyManifestPath = path.join(
  atlasRoot,
  "docs",
  "LIFELINE_TOPOLOGY_MANIFEST.json",
);
const docsPath = path.join(
  repoRoot,
  "docs",
  "contracts",
  "topology-manifest.md",
);
const modulePath = path.join(repoRoot, "dist", "core", "topology-manifest.js");

const {
  TOPOLOGY_MANIFEST_SCHEMA_VERSION,
  resolveTopologySurface,
  validateTopologyManifest,
} = await import(pathToFileURL(modulePath).href);

const [rawManifest, docs] = await Promise.all([
  readFile(topologyManifestPath, "utf8"),
  readFile(docsPath, "utf8"),
]);

const manifest = validateTopologyManifest(JSON.parse(rawManifest));

assert.equal(manifest.schema_version, TOPOLOGY_MANIFEST_SCHEMA_VERSION);
assert.deepEqual(manifest.source_docs, [
  "docs/LIFELINE_HOSTING_TOPOLOGY.md",
  "docs/LIFELINE_ENV_AND_DOMAIN_CONTRACT.md",
]);

const troveProd = resolveTopologySurface(manifest, "trove", "prod");
assert.equal(troveProd.serviceKey, "trove/prod");
assert.equal(troveProd.hostname, "trove.fawxzzy.com");
assert.equal(troveProd.publicHostnameMode, "default");
assert.equal(troveProd.ruleId, "prod");

const trovePreview = resolveTopologySurface(manifest, "trove", "preview");
assert.equal(trovePreview.serviceKey, "trove/preview");
assert.equal(trovePreview.hostname, "preview-trove.fawxzzy.com");
assert.equal(trovePreview.publicHostnameMode, "default");
assert.equal(trovePreview.ruleId, "preview");

const trovePr = resolveTopologySurface(manifest, "trove", "pr-18");
assert.equal(trovePr.environmentKind, "ephemeral");
assert.equal(trovePr.serviceKey, "trove/pr-18");
assert.equal(trovePr.hostname, "pr-18.trove.fawxzzy.com");
assert.equal(trovePr.publicHostnameMode, "default");
assert.equal(trovePr.ruleId, "pr-preview");

const fitnessDev = resolveTopologySurface(manifest, "fitness", "dev");
assert.equal(fitnessDev.serviceKey, "fitness/dev");
assert.equal(fitnessDev.hostname, undefined);
assert.equal(fitnessDev.publicHostnameMode, "none");
assert.equal(fitnessDev.ruleId, undefined);

const lifelineProd = resolveTopologySurface(manifest, "lifeline", "prod");
assert.equal(lifelineProd.serviceKey, "lifeline/prod");
assert.equal(lifelineProd.hostname, "lifeline.fawxzzy.com");
assert.equal(lifelineProd.publicHostnameMode, "intentional");
assert.equal(lifelineProd.ruleId, "lifeline-prod");

const lifelinePreview = resolveTopologySurface(
  manifest,
  "lifeline",
  "preview",
);
assert.equal(lifelinePreview.serviceKey, "lifeline/preview");
assert.equal(lifelinePreview.hostname, undefined);
assert.equal(lifelinePreview.publicHostnameMode, "none");
assert.equal(lifelinePreview.ruleId, "preview");

assert.throws(
  () => resolveTopologySurface(manifest, "trove", "qa"),
  /Unknown topology environment "qa"\./,
);
assert.throws(
  () => resolveTopologySurface(manifest, "unknown-app", "prod"),
  /Unknown topology app "unknown-app"\./,
);

assert(
  docs.includes("atlas.topology.manifest.v1") &&
    docs.includes("ATLAS-owned topology manifest") &&
    docs.includes("app/environment") &&
    docs.includes("domain automation") &&
    docs.includes("TLS automation"),
  "topology-manifest doc must describe the intake boundary and exclusions",
);

console.log("Topology manifest deterministic verification passed.");
