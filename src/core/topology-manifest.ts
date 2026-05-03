import { ValidationError } from "./errors.js";

export const TOPOLOGY_MANIFEST_SCHEMA_VERSION = "atlas.topology.manifest.v1";

export interface TopologyIdentity {
  service_key_template: string;
  stable_public_unit: string;
  machine_identity_visibility: string;
  routing_default: string;
}

export interface TopologyApp {
  app_id: string;
  repo_id: string;
  surface: string;
  default_zone: string;
  prod_hostname_mode: string;
  preview_hostname_mode: string;
  pr_preview_hostname_mode: string;
}

export interface TopologyZone {
  zone: string;
  kind: string;
  status: string;
}

export interface NamedTopologyEnvironment {
  name: string;
  kind: string;
  public_hostname_mode: string;
}

export interface EphemeralTopologyEnvironment {
  kind: string;
  environment_template: string;
  match: string;
  public_hostname_mode: string;
}

export interface TopologyEnvironments {
  named: NamedTopologyEnvironment[];
  ephemeral: EphemeralTopologyEnvironment[];
}

export interface TopologyHostnameRule {
  rule_id: string;
  kind: string;
  environment?: string;
  environment_template?: string;
  app_id?: string;
  hostname_template: string;
  service_key_template: string;
  default_hostname_mode: string;
}

export interface TopologyRouting {
  default_strategy: string;
  path_routing_default: string;
  path_routing_allowed_for: string[];
  gateway_resolves_service_before_placement: boolean;
  tls_termination: string;
  cookie_boundary: string;
  public_hostname_must_hide: string[];
}

export interface TopologyPlacement {
  stable_contract_unit: string;
  public_hostname_changes_with_placement: boolean;
  default_topology: string;
  stage_progression: string[];
  lifeline_v1_exclusions: string[];
}

export interface TopologyManifest {
  schema_version: string;
  source_docs: string[];
  identity: TopologyIdentity;
  apps: TopologyApp[];
  zones: TopologyZone[];
  environments: TopologyEnvironments;
  hostname_rules: TopologyHostnameRule[];
  routing: TopologyRouting;
  placement: TopologyPlacement;
}

export interface ResolvedTopologySurface {
  appId: string;
  environment: string;
  environmentKind: "named" | "ephemeral";
  zone: string;
  serviceKey: string;
  publicHostnameMode: string;
  hostname?: string;
  ruleId?: string;
}

interface MatchedEnvironment {
  kind: "named" | "ephemeral";
  publicHostnameMode: string;
  variables: Record<string, string>;
  definition: NamedTopologyEnvironment | EphemeralTopologyEnvironment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object.`);
  }

  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${path} must be a non-empty string.`);
  }

  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${path} must be a boolean.`);
  }

  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${path} must be an array.`);
  }

  return value;
}

function expectStringArray(value: unknown, path: string): string[] {
  return expectArray(value, path).map((entry, index) =>
    expectString(entry, `${path}[${index}]`),
  );
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new ValidationError(
        `${path} contains unsupported key "${key}".`,
      );
    }
  }
}

function parseIdentity(value: unknown, path: string): TopologyIdentity {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    [
      "service_key_template",
      "stable_public_unit",
      "machine_identity_visibility",
      "routing_default",
    ],
    path,
  );

  return {
    service_key_template: expectString(
      record.service_key_template,
      `${path}.service_key_template`,
    ),
    stable_public_unit: expectString(
      record.stable_public_unit,
      `${path}.stable_public_unit`,
    ),
    machine_identity_visibility: expectString(
      record.machine_identity_visibility,
      `${path}.machine_identity_visibility`,
    ),
    routing_default: expectString(
      record.routing_default,
      `${path}.routing_default`,
    ),
  };
}

function parseApp(value: unknown, path: string): TopologyApp {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    [
      "app_id",
      "repo_id",
      "surface",
      "default_zone",
      "prod_hostname_mode",
      "preview_hostname_mode",
      "pr_preview_hostname_mode",
    ],
    path,
  );

  return {
    app_id: expectString(record.app_id, `${path}.app_id`),
    repo_id: expectString(record.repo_id, `${path}.repo_id`),
    surface: expectString(record.surface, `${path}.surface`),
    default_zone: expectString(record.default_zone, `${path}.default_zone`),
    prod_hostname_mode: expectString(
      record.prod_hostname_mode,
      `${path}.prod_hostname_mode`,
    ),
    preview_hostname_mode: expectString(
      record.preview_hostname_mode,
      `${path}.preview_hostname_mode`,
    ),
    pr_preview_hostname_mode: expectString(
      record.pr_preview_hostname_mode,
      `${path}.pr_preview_hostname_mode`,
    ),
  };
}

function parseZone(value: unknown, path: string): TopologyZone {
  const record = expectRecord(value, path);
  assertAllowedKeys(record, ["zone", "kind", "status"], path);

  return {
    zone: expectString(record.zone, `${path}.zone`),
    kind: expectString(record.kind, `${path}.kind`),
    status: expectString(record.status, `${path}.status`),
  };
}

function parseNamedEnvironment(
  value: unknown,
  path: string,
): NamedTopologyEnvironment {
  const record = expectRecord(value, path);
  assertAllowedKeys(record, ["name", "kind", "public_hostname_mode"], path);

  return {
    name: expectString(record.name, `${path}.name`),
    kind: expectString(record.kind, `${path}.kind`),
    public_hostname_mode: expectString(
      record.public_hostname_mode,
      `${path}.public_hostname_mode`,
    ),
  };
}

function parseEphemeralEnvironment(
  value: unknown,
  path: string,
): EphemeralTopologyEnvironment {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    ["kind", "environment_template", "match", "public_hostname_mode"],
    path,
  );

  return {
    kind: expectString(record.kind, `${path}.kind`),
    environment_template: expectString(
      record.environment_template,
      `${path}.environment_template`,
    ),
    match: expectString(record.match, `${path}.match`),
    public_hostname_mode: expectString(
      record.public_hostname_mode,
      `${path}.public_hostname_mode`,
    ),
  };
}

function parseEnvironments(
  value: unknown,
  path: string,
): TopologyEnvironments {
  const record = expectRecord(value, path);
  assertAllowedKeys(record, ["named", "ephemeral"], path);

  return {
    named: expectArray(record.named, `${path}.named`).map((entry, index) =>
      parseNamedEnvironment(entry, `${path}.named[${index}]`),
    ),
    ephemeral: expectArray(record.ephemeral, `${path}.ephemeral`).map(
      (entry, index) =>
        parseEphemeralEnvironment(entry, `${path}.ephemeral[${index}]`),
    ),
  };
}

function parseHostnameRule(
  value: unknown,
  path: string,
): TopologyHostnameRule {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    [
      "rule_id",
      "kind",
      "environment",
      "environment_template",
      "app_id",
      "hostname_template",
      "service_key_template",
      "default_hostname_mode",
    ],
    path,
  );

  const kind = expectString(record.kind, `${path}.kind`);
  const environment =
    record.environment === undefined
      ? undefined
      : expectString(record.environment, `${path}.environment`);
  const environmentTemplate =
    record.environment_template === undefined
      ? undefined
      : expectString(
          record.environment_template,
          `${path}.environment_template`,
        );

  if (kind === "named" && !environment) {
    throw new ValidationError(
      `${path}.environment is required for named hostname rules.`,
    );
  }

  if (kind === "ephemeral" && !environmentTemplate) {
    throw new ValidationError(
      `${path}.environment_template is required for ephemeral hostname rules.`,
    );
  }

  return {
    rule_id: expectString(record.rule_id, `${path}.rule_id`),
    kind,
    ...(environment ? { environment } : {}),
    ...(environmentTemplate
      ? { environment_template: environmentTemplate }
      : {}),
    ...(record.app_id === undefined
      ? {}
      : { app_id: expectString(record.app_id, `${path}.app_id`) }),
    hostname_template: expectString(
      record.hostname_template,
      `${path}.hostname_template`,
    ),
    service_key_template: expectString(
      record.service_key_template,
      `${path}.service_key_template`,
    ),
    default_hostname_mode: expectString(
      record.default_hostname_mode,
      `${path}.default_hostname_mode`,
    ),
  };
}

function parseRouting(value: unknown, path: string): TopologyRouting {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    [
      "default_strategy",
      "path_routing_default",
      "path_routing_allowed_for",
      "gateway_resolves_service_before_placement",
      "tls_termination",
      "cookie_boundary",
      "public_hostname_must_hide",
    ],
    path,
  );

  return {
    default_strategy: expectString(
      record.default_strategy,
      `${path}.default_strategy`,
    ),
    path_routing_default: expectString(
      record.path_routing_default,
      `${path}.path_routing_default`,
    ),
    path_routing_allowed_for: expectStringArray(
      record.path_routing_allowed_for,
      `${path}.path_routing_allowed_for`,
    ),
    gateway_resolves_service_before_placement: expectBoolean(
      record.gateway_resolves_service_before_placement,
      `${path}.gateway_resolves_service_before_placement`,
    ),
    tls_termination: expectString(
      record.tls_termination,
      `${path}.tls_termination`,
    ),
    cookie_boundary: expectString(
      record.cookie_boundary,
      `${path}.cookie_boundary`,
    ),
    public_hostname_must_hide: expectStringArray(
      record.public_hostname_must_hide,
      `${path}.public_hostname_must_hide`,
    ),
  };
}

function parsePlacement(value: unknown, path: string): TopologyPlacement {
  const record = expectRecord(value, path);
  assertAllowedKeys(
    record,
    [
      "stable_contract_unit",
      "public_hostname_changes_with_placement",
      "default_topology",
      "stage_progression",
      "lifeline_v1_exclusions",
    ],
    path,
  );

  return {
    stable_contract_unit: expectString(
      record.stable_contract_unit,
      `${path}.stable_contract_unit`,
    ),
    public_hostname_changes_with_placement: expectBoolean(
      record.public_hostname_changes_with_placement,
      `${path}.public_hostname_changes_with_placement`,
    ),
    default_topology: expectString(
      record.default_topology,
      `${path}.default_topology`,
    ),
    stage_progression: expectStringArray(
      record.stage_progression,
      `${path}.stage_progression`,
    ),
    lifeline_v1_exclusions: expectStringArray(
      record.lifeline_v1_exclusions,
      `${path}.lifeline_v1_exclusions`,
    ),
  };
}

function assertUniqueStrings(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ValidationError(`${path} must not contain duplicates: ${value}.`);
    }
    seen.add(value);
  }
}

function compileEnvironmentTemplate(template: string): RegExp {
  const pattern = template.replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_, name: string) => `(?<${name}>[^.\\/]+)`,
  );
  return new RegExp(`^${pattern}$`);
}

function matchEnvironment(
  manifest: TopologyManifest,
  environment: string,
): MatchedEnvironment {
  const named = manifest.environments.named.find(
    (entry) => entry.name === environment,
  );
  if (named) {
    return {
      kind: "named",
      publicHostnameMode: named.public_hostname_mode,
      variables: {},
      definition: named,
    };
  }

  for (const entry of manifest.environments.ephemeral) {
    const matcher = new RegExp(entry.match);
    if (!matcher.test(environment)) {
      continue;
    }

    const templateMatch = compileEnvironmentTemplate(
      entry.environment_template,
    ).exec(environment);

    return {
      kind: "ephemeral",
      publicHostnameMode: entry.public_hostname_mode,
      variables: templateMatch?.groups
        ? Object.fromEntries(Object.entries(templateMatch.groups))
        : {},
      definition: entry,
    };
  }

  throw new ValidationError(
    `Unknown topology environment "${environment}".`,
  );
}

function resolvePublicHostnameMode(
  app: TopologyApp,
  environment: string,
  matchedEnvironment: MatchedEnvironment,
): string {
  if (matchedEnvironment.kind === "ephemeral") {
    return app.pr_preview_hostname_mode;
  }

  if (environment === "prod") {
    return app.prod_hostname_mode;
  }

  if (environment === "preview") {
    return app.preview_hostname_mode;
  }

  return matchedEnvironment.publicHostnameMode;
}

function applyTemplate(
  template: string,
  values: Record<string, string>,
  path: string,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const resolved = values[key];
    if (!resolved) {
      throw new ValidationError(
        `${path} references missing template value "${key}".`,
      );
    }
    return resolved;
  });
}

function selectHostnameRule(
  manifest: TopologyManifest,
  appId: string,
  environment: string,
  matchedEnvironment: MatchedEnvironment,
): TopologyHostnameRule | undefined {
  const candidates = manifest.hostname_rules.filter((rule) => {
    if (rule.kind !== matchedEnvironment.kind) {
      return false;
    }

    if (matchedEnvironment.kind === "named" && rule.environment !== environment) {
      return false;
    }

    if (
      matchedEnvironment.kind === "ephemeral" &&
      rule.environment_template !==
        (matchedEnvironment.definition as EphemeralTopologyEnvironment)
          .environment_template
    ) {
      return false;
    }

    if (rule.app_id && rule.app_id !== appId) {
      return false;
    }

    return true;
  });

  candidates.sort((left, right) => {
    const leftSpecificity = left.app_id ? 1 : 0;
    const rightSpecificity = right.app_id ? 1 : 0;
    return rightSpecificity - leftSpecificity;
  });

  return candidates[0];
}

function validateManifestRelationships(manifest: TopologyManifest): void {
  assertUniqueStrings(
    manifest.apps.map((entry) => entry.app_id),
    "apps.app_id",
  );
  assertUniqueStrings(
    manifest.zones.map((entry) => entry.zone),
    "zones.zone",
  );
  assertUniqueStrings(
    manifest.environments.named.map((entry) => entry.name),
    "environments.named.name",
  );
  assertUniqueStrings(
    manifest.hostname_rules.map((entry) => entry.rule_id),
    "hostname_rules.rule_id",
  );

  const zoneNames = new Set(manifest.zones.map((entry) => entry.zone));
  for (const app of manifest.apps) {
    if (!zoneNames.has(app.default_zone)) {
      throw new ValidationError(
        `App ${app.app_id} references unknown zone ${app.default_zone}.`,
      );
    }
  }

  const appIds = new Set(manifest.apps.map((entry) => entry.app_id));
  const namedEnvironmentNames = new Set(
    manifest.environments.named.map((entry) => entry.name),
  );
  const ephemeralTemplates = new Set(
    manifest.environments.ephemeral.map((entry) => entry.environment_template),
  );

  for (const rule of manifest.hostname_rules) {
    if (rule.app_id && !appIds.has(rule.app_id)) {
      throw new ValidationError(
        `Hostname rule ${rule.rule_id} references unknown app ${rule.app_id}.`,
      );
    }

    if (rule.kind === "named") {
      if (!rule.environment || !namedEnvironmentNames.has(rule.environment)) {
        throw new ValidationError(
          `Hostname rule ${rule.rule_id} references unknown named environment ${rule.environment ?? "<missing>"}.`,
        );
      }
    }

    if (rule.kind === "ephemeral") {
      if (
        !rule.environment_template ||
        !ephemeralTemplates.has(rule.environment_template)
      ) {
        throw new ValidationError(
          `Hostname rule ${rule.rule_id} references unknown ephemeral environment template ${rule.environment_template ?? "<missing>"}.`,
        );
      }
    }
  }
}

export function validateTopologyManifest(input: unknown): TopologyManifest {
  const record = expectRecord(input, "topologyManifest");
  assertAllowedKeys(
    record,
    [
      "schema_version",
      "source_docs",
      "identity",
      "apps",
      "zones",
      "environments",
      "hostname_rules",
      "routing",
      "placement",
    ],
    "topologyManifest",
  );

  const manifest: TopologyManifest = {
    schema_version: expectString(
      record.schema_version,
      "topologyManifest.schema_version",
    ),
    source_docs: expectStringArray(
      record.source_docs,
      "topologyManifest.source_docs",
    ),
    identity: parseIdentity(record.identity, "topologyManifest.identity"),
    apps: expectArray(record.apps, "topologyManifest.apps").map((entry, index) =>
      parseApp(entry, `topologyManifest.apps[${index}]`),
    ),
    zones: expectArray(record.zones, "topologyManifest.zones").map(
      (entry, index) => parseZone(entry, `topologyManifest.zones[${index}]`),
    ),
    environments: parseEnvironments(
      record.environments,
      "topologyManifest.environments",
    ),
    hostname_rules: expectArray(
      record.hostname_rules,
      "topologyManifest.hostname_rules",
    ).map((entry, index) =>
      parseHostnameRule(entry, `topologyManifest.hostname_rules[${index}]`),
    ),
    routing: parseRouting(record.routing, "topologyManifest.routing"),
    placement: parsePlacement(record.placement, "topologyManifest.placement"),
  };

  if (manifest.schema_version !== TOPOLOGY_MANIFEST_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported topology manifest schema version ${manifest.schema_version}. Supported version: ${TOPOLOGY_MANIFEST_SCHEMA_VERSION}.`,
    );
  }

  validateManifestRelationships(manifest);

  return manifest;
}

export function resolveTopologySurface(
  manifest: TopologyManifest,
  appId: string,
  environment: string,
): ResolvedTopologySurface {
  const app = manifest.apps.find((entry) => entry.app_id === appId);
  if (!app) {
    throw new ValidationError(`Unknown topology app "${appId}".`);
  }

  const matchedEnvironment = matchEnvironment(manifest, environment);
  const publicHostnameMode = resolvePublicHostnameMode(
    app,
    environment,
    matchedEnvironment,
  );
  const rule = selectHostnameRule(
    manifest,
    appId,
    environment,
    matchedEnvironment,
  );
  const zone = app.default_zone;
  const templateValues = {
    app: app.app_id,
    environment,
    zone,
    ...matchedEnvironment.variables,
  };
  const serviceKeyTemplate =
    rule?.service_key_template ?? manifest.identity.service_key_template;
  const serviceKey = applyTemplate(
    serviceKeyTemplate,
    templateValues,
    "service_key_template",
  );

  if (publicHostnameMode === "none") {
    return {
      appId: app.app_id,
      environment,
      environmentKind: matchedEnvironment.kind,
      zone,
      serviceKey,
      publicHostnameMode,
      ...(rule ? { ruleId: rule.rule_id } : {}),
    };
  }

  if (!rule) {
    throw new ValidationError(
      `No hostname rule found for ${appId}/${environment}.`,
    );
  }

  return {
    appId: app.app_id,
    environment,
    environmentKind: matchedEnvironment.kind,
    zone,
    serviceKey,
    publicHostnameMode,
    hostname: applyTemplate(
      rule.hostname_template,
      templateValues,
      `${rule.rule_id}.hostname_template`,
    ),
    ruleId: rule.rule_id,
  };
}
