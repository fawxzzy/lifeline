import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const docsPath = path.join(
  repoRoot,
  "docs",
  "contracts",
  "topology-manifest.md",
);
const modulePath = path.join(repoRoot, "dist", "core", "topology-manifest.js");

const rawManifest = JSON.stringify({
  schema_version: "atlas.topology.manifest.v1",
  source_docs: [
    "docs/LIFELINE_HOSTING_TOPOLOGY.md",
    "docs/LIFELINE_ENV_AND_DOMAIN_CONTRACT.md",
  ],
  identity: {
    service_key_template: "{app}/{environment}",
    stable_public_unit: "app/environment",
    machine_identity_visibility: "hidden",
    routing_default: "subdomain-first",
  },
  apps: [
    {
      app_id: "fitness",
      repo_id: "fitness",
      surface: "product",
      default_zone: "fawxzzy.com",
      prod_hostname_mode: "default",
      preview_hostname_mode: "default",
      pr_preview_hostname_mode: "default",
    },
    {
      app_id: "mazer",
      repo_id: "mazer",
      surface: "product",
      default_zone: "fawxzzy.com",
      prod_hostname_mode: "default",
      preview_hostname_mode: "default",
      pr_preview_hostname_mode: "default",
    },
    {
      app_id: "trove",
      repo_id: "trove",
      surface: "product",
      default_zone: "fawxzzy.com",
      prod_hostname_mode: "default",
      preview_hostname_mode: "default",
      pr_preview_hostname_mode: "default",
    },
    {
      app_id: "lifeline",
      repo_id: "lifeline",
      surface: "operator",
      default_zone: "fawxzzy.com",
      prod_hostname_mode: "intentional",
      preview_hostname_mode: "none",
      pr_preview_hostname_mode: "none",
    },
  ],
  zones: [
    {
      zone: "fawxzzy.com",
      kind: "primary-public",
      status: "active",
    },
  ],
  environments: {
    named: [
      {
        name: "dev",
        kind: "local",
        public_hostname_mode: "none",
      },
      {
        name: "preview",
        kind: "shared-preview",
        public_hostname_mode: "default",
      },
      {
        name: "prod",
        kind: "production",
        public_hostname_mode: "default",
      },
    ],
    ephemeral: [
      {
        kind: "pr",
        environment_template: "pr-{number}",
        match: "^pr-[1-9][0-9]*$",
        public_hostname_mode: "default",
      },
    ],
  },
  hostname_rules: [
    {
      rule_id: "prod",
      kind: "named",
      environment: "prod",
      hostname_template: "{app}.{zone}",
      service_key_template: "{app}/prod",
      default_hostname_mode: "default",
    },
    {
      rule_id: "preview",
      kind: "named",
      environment: "preview",
      hostname_template: "preview-{app}.{zone}",
      service_key_template: "{app}/preview",
      default_hostname_mode: "default",
    },
    {
      rule_id: "pr-preview",
      kind: "ephemeral",
      environment_template: "pr-{number}",
      hostname_template: "pr-{number}.{app}.{zone}",
      service_key_template: "{app}/pr-{number}",
      default_hostname_mode: "default",
    },
    {
      rule_id: "lifeline-prod",
      kind: "named",
      environment: "prod",
      app_id: "lifeline",
      hostname_template: "lifeline.{zone}",
      service_key_template: "lifeline/prod",
      default_hostname_mode: "intentional",
    },
  ],
  routing: {
    default_strategy: "subdomain-first",
    path_routing_default: "disallowed-for-distinct-apps",
    path_routing_allowed_for: [
      "docs",
      "admin",
      "internal-tools",
      "tightly-coupled-surfaces",
    ],
    gateway_resolves_service_before_placement: true,
    tls_termination: "gateway",
    cookie_boundary: "application-hostname",
    public_hostname_must_hide: [
      "machine_id",
      "provider_instance_id",
      "placement",
    ],
  },
  placement: {
    stable_contract_unit: "app/environment",
    public_hostname_changes_with_placement: false,
    default_topology: "shared-gateway-isolated-services",
    stage_progression: [
      "single-host-many-services",
      "shared-gateway-plus-worker-hosts",
      "lifeline-controlled-multi-host",
    ],
    lifeline_v1_exclusions: [
      "hosted-control-plane",
      "reverse-proxy-ownership",
      "domain-automation",
      "tls-automation",
      "multi-node-orchestration",
    ],
  },
});

const {
  TOPOLOGY_MANIFEST_SCHEMA_VERSION,
  resolveTopologySurface,
  validateTopologyManifest,
} = await import(pathToFileURL(modulePath).href);

const docs = await readFile(docsPath, "utf8");

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
