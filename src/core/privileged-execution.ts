import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ValidationError } from "./errors.js";
import { getLifelineReceiptsDirectory } from "./lifeline-root.js";
import {
  normalizeCapturedText,
  normalizeReceiptPath,
  stableJsonStringify,
  writeJsonFile,
} from "./receipt-store.js";
import { loadGovernedRegistry } from "./tool-registry.js";
import type { GovernedRegistryBundle } from "./tool-registry.js";

const REQUEST_CONTRACT_VERSION = "atlas.privileged-action.request.v1";
const APPROVAL_CONTRACT_VERSION = "atlas.approval.receipt.v1";
const CAPABILITY_CONTRACT_VERSION = "atlas.capability.profile.v1";
const RECEIPT_CONTRACT_VERSION = "atlas.privileged-action.receipt.v1";
const RECONCILED_BY_TOOL_VERSION = "lifeline.privileged-execution-repair.v1";
const AUTOMATION_LEVELS = [
  "observe",
  "context",
  "request_action",
  "approved_action",
] as const;
type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];
const REQUEST_AUTOMATION_LEVEL: AutomationLevel = "request_action";
const APPROVED_AUTOMATION_LEVEL: AutomationLevel = "approved_action";

type ExecutionMode =
  | "read_only_scan"
  | "dry_run_command"
  | "workspace_file_apply";
type ResultState = "succeeded" | "failed" | "blocked";

interface ScopeSet {
  read: string[];
  write: string[];
  create: string[];
  deny: string[];
}

interface CapabilityProfile {
  contract_version: string;
  capability_profile_id: string;
  filesystem_scopes: ScopeSet;
  network_scopes: {
    mode: string;
    allowed_domains: string[];
    blocked_domains: string[];
  };
  process_execution_permissions: {
    allow_spawn: boolean;
    allow_shell: boolean;
    allow_python: boolean;
    allowed_commands: string[];
    denied_commands: string[];
  };
  package_manager_permissions: {
    allow_install: boolean;
    allow_update: boolean;
    allowed_managers: string[];
    blocked_managers: string[];
  };
  elevation_requirement: "none" | "per_action_approval" | "host_gated";
  resource_budgets: {
    wall_clock_seconds: number;
    cpu_seconds: number;
    memory_mb: number;
    disk_mb: number;
  };
  allowed_data_classes: string[];
  description?: string;
  audit_class?: string;
}

interface PrivilegedActionRequest {
  contract_version: string;
  request_id: string;
  requested_at: string;
  worker_id: string;
  assignment_id: string;
  stack_lock_digest: string;
  tool_id: string;
  extension_id: string | null;
  registry_digest: string;
  automation_level: AutomationLevel;
  source_refs?: string[];
  action: {
    summary: string;
    operation:
      | "read_only_scan"
      | "scoped_write"
      | "package_install"
      | "admin_action";
    command: string[];
    cwd: string;
    workspace_root?: string;
    write_target?: string;
    write_content?: string;
  };
  target_paths?: string[];
  target_resources?: string[];
  requested_capability: CapabilityProfile;
  dry_run_output?: string;
  justification?: string;
  requested_expiry_at?: string;
}

interface ApprovalReceipt {
  contract_version: string;
  approval_receipt_id: string;
  request_id: string;
  worker_id: string;
  assignment_id: string;
  stack_lock_digest: string;
  tool_id: string;
  extension_id: string | null;
  registry_digest: string;
  automation_level: AutomationLevel;
  approver: {
    kind: "system" | "human";
    name: string;
  };
  approval_status: "approved" | "rejected" | "expired";
  granted_scope: CapabilityProfile | null;
  expiry_at?: string | null;
  request_digest: string;
  issued_at: string;
  reason?: string;
}

interface InspectionRecord {
  path: string;
  exists: boolean;
  kind: "file" | "directory" | "other" | "missing";
  size_bytes?: number;
  sha256?: string;
  line_count?: number;
  child_count?: number;
  entries?: Array<{ name: string; kind: string }>;
}

interface WriteResultRecord {
  workspace_root: string;
  target_path: string;
  applied_at: string;
  prior_sha256?: string;
  backup_ref?: string;
}

interface PrivilegedActionReceipt {
  contract_version: string;
  receipt_id: string;
  executed_at: string;
  worker_id: string;
  assignment_id: string;
  stack_lock_digest: string;
  tool_id: string;
  extension_id: string | null;
  registry_digest: string;
  automation_level: AutomationLevel;
  capability_profile_id: string;
  request_id: string;
  approval_receipt_id: string;
  approval_status: ApprovalReceipt["approval_status"];
  execution_mode: ExecutionMode;
  host: {
    name: string;
    platform: string;
  };
  requested_action: PrivilegedActionRequest["action"];
  target_paths: string[];
  target_resources: string[];
  source_refs: string[];
  request_digest: string;
  capability_profile_digest: string;
  approval_digest: string;
  result: ResultState;
  failure?: {
    category: "config_error" | "environment_error" | "runtime_error";
    first_remediation_step: string;
  };
  blocked_reason?: string;
  inspection?: {
    cwd: string;
    records: InspectionRecord[];
  };
  command_result?: {
    command: string[];
    cwd: string;
    exit_code: number;
    stdout: string;
    stderr: string;
  };
  execution_notes?: string;
  write_results?: WriteResultRecord[];
  supersedes_receipt_ref?: string;
  repair_basis_refs?: string[];
  reconciled_at?: string;
  reconciled_by_tool_version?: string;
}

interface ExecutionResult {
  receipt: PrivilegedActionReceipt;
  receiptPath: string;
  exitCode: number;
}

type ReceiptFailureCategory = NonNullable<PrivilegedActionReceipt["failure"]>["category"];

export interface RepairPrivilegedActionReceiptResult {
  status: "repaired" | "replay_required";
  reason?: string;
  originalReceiptRef: string;
  repairBasisRefs: string[];
  repairedReceipt?: PrivilegedActionReceipt;
  repairedReceiptPath?: string;
  repairedReceiptRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new ValidationError(`${field} must be an array of strings.`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string.`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ValidationError(`${field} must be a number.`);
  }
  return value;
}

function asAutomationLevel(value: unknown, field: string): AutomationLevel {
  const automationLevel = asString(value, field) as AutomationLevel;
  if (!AUTOMATION_LEVELS.includes(automationLevel)) {
    throw new ValidationError(
      `${field} must be one of: ${AUTOMATION_LEVELS.join(", ")}.`,
    );
  }
  return automationLevel;
}

function automationLevelAllows(
  maxLevel: AutomationLevel,
  requestedLevel: AutomationLevel,
): boolean {
  return (
    AUTOMATION_LEVELS.indexOf(requestedLevel) <=
    AUTOMATION_LEVELS.indexOf(maxLevel)
  );
}

async function loadJson(pathValue: string): Promise<Record<string, unknown>> {
  const raw = await readFile(pathValue, "utf8").catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ValidationError(
      `Could not read JSON file at ${pathValue}: ${message}`,
    );
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new ValidationError(
      `Could not parse JSON in ${pathValue}: ${message}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ValidationError(
      `JSON file at ${pathValue} must contain an object.`,
    );
  }

  return parsed;
}

function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern.trim());
  if (normalized === "." || normalized === "./") {
    return /^.*$/;
  }

  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";

    if (char === "*" && next === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      expression += "[^/]*";
      continue;
    }

    if (char === "?") {
      expression += "[^/]";
      continue;
    }

    if ("\\^$+?.()|{}[]".includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }

  return new RegExp(`${expression}$`);
}

function matchesPattern(candidate: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern.trim());
  if (normalizedPattern === "." || normalizedPattern === "./") {
    return true;
  }

  return globToRegExp(normalizedPattern).test(normalizePath(candidate));
}

function matchesAny(candidate: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(candidate, pattern));
}

function validateCapabilityProfile(value: unknown): CapabilityProfile {
  if (!isRecord(value)) {
    throw new ValidationError("Capability profile must be an object.");
  }

  if (value.contract_version !== CAPABILITY_CONTRACT_VERSION) {
    throw new ValidationError(
      `capability_profile.contract_version must be '${CAPABILITY_CONTRACT_VERSION}'.`,
    );
  }

  const filesystemScopes = value.filesystem_scopes;
  const networkScopes = value.network_scopes;
  const processPermissions = value.process_execution_permissions;
  const packagePermissions = value.package_manager_permissions;
  const resourceBudgets = value.resource_budgets;

  if (
    !isRecord(filesystemScopes) ||
    !isRecord(networkScopes) ||
    !isRecord(processPermissions) ||
    !isRecord(packagePermissions) ||
    !isRecord(resourceBudgets)
  ) {
    throw new ValidationError(
      "Capability profile is missing required scope blocks.",
    );
  }

  return {
    contract_version: CAPABILITY_CONTRACT_VERSION,
    capability_profile_id: asString(
      value.capability_profile_id,
      "capability_profile.capability_profile_id",
    ),
    filesystem_scopes: {
      read: asStringArray(
        filesystemScopes.read,
        "capability_profile.filesystem_scopes.read",
      ),
      write: asStringArray(
        filesystemScopes.write,
        "capability_profile.filesystem_scopes.write",
      ),
      create: asStringArray(
        filesystemScopes.create,
        "capability_profile.filesystem_scopes.create",
      ),
      deny: asStringArray(
        filesystemScopes.deny ?? [],
        "capability_profile.filesystem_scopes.deny",
      ),
    },
    network_scopes: {
      mode: asString(
        networkScopes.mode,
        "capability_profile.network_scopes.mode",
      ),
      allowed_domains: asStringArray(
        networkScopes.allowed_domains,
        "capability_profile.network_scopes.allowed_domains",
      ),
      blocked_domains: asStringArray(
        networkScopes.blocked_domains ?? [],
        "capability_profile.network_scopes.blocked_domains",
      ),
    },
    process_execution_permissions: {
      allow_spawn: asBoolean(
        processPermissions.allow_spawn,
        "capability_profile.process_execution_permissions.allow_spawn",
      ),
      allow_shell: asBoolean(
        processPermissions.allow_shell,
        "capability_profile.process_execution_permissions.allow_shell",
      ),
      allow_python: asBoolean(
        processPermissions.allow_python,
        "capability_profile.process_execution_permissions.allow_python",
      ),
      allowed_commands: asStringArray(
        processPermissions.allowed_commands ?? [],
        "capability_profile.process_execution_permissions.allowed_commands",
      ),
      denied_commands: asStringArray(
        processPermissions.denied_commands ?? [],
        "capability_profile.process_execution_permissions.denied_commands",
      ),
    },
    package_manager_permissions: {
      allow_install: asBoolean(
        packagePermissions.allow_install,
        "capability_profile.package_manager_permissions.allow_install",
      ),
      allow_update: asBoolean(
        packagePermissions.allow_update,
        "capability_profile.package_manager_permissions.allow_update",
      ),
      allowed_managers: asStringArray(
        packagePermissions.allowed_managers,
        "capability_profile.package_manager_permissions.allowed_managers",
      ),
      blocked_managers: asStringArray(
        packagePermissions.blocked_managers ?? [],
        "capability_profile.package_manager_permissions.blocked_managers",
      ),
    },
    elevation_requirement: asString(
      value.elevation_requirement,
      "capability_profile.elevation_requirement",
    ) as CapabilityProfile["elevation_requirement"],
    resource_budgets: {
      wall_clock_seconds: asNumber(
        resourceBudgets.wall_clock_seconds,
        "capability_profile.resource_budgets.wall_clock_seconds",
      ),
      cpu_seconds: asNumber(
        resourceBudgets.cpu_seconds,
        "capability_profile.resource_budgets.cpu_seconds",
      ),
      memory_mb: asNumber(
        resourceBudgets.memory_mb,
        "capability_profile.resource_budgets.memory_mb",
      ),
      disk_mb: asNumber(
        resourceBudgets.disk_mb,
        "capability_profile.resource_budgets.disk_mb",
      ),
    },
    allowed_data_classes: asStringArray(
      value.allowed_data_classes,
      "capability_profile.allowed_data_classes",
    ),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(typeof value.audit_class === "string"
      ? { audit_class: value.audit_class }
      : {}),
  };
}

function validateRequest(value: unknown): PrivilegedActionRequest {
  if (!isRecord(value)) {
    throw new ValidationError("Privileged action request must be an object.");
  }

  if (value.contract_version !== REQUEST_CONTRACT_VERSION) {
    throw new ValidationError(
      `request.contract_version must be '${REQUEST_CONTRACT_VERSION}'.`,
    );
  }

  const action = value.action;
  const requestedCapability = validateCapabilityProfile(
    value.requested_capability,
  );

  if (!isRecord(action)) {
    throw new ValidationError("request.action must be an object.");
  }

  return {
    contract_version: REQUEST_CONTRACT_VERSION,
    request_id: asString(value.request_id, "request.request_id"),
    requested_at: asString(value.requested_at, "request.requested_at"),
    worker_id: asString(value.worker_id, "request.worker_id"),
    assignment_id: asString(value.assignment_id, "request.assignment_id"),
    stack_lock_digest: asString(
      value.stack_lock_digest,
      "request.stack_lock_digest",
    ),
    tool_id: asString(value.tool_id, "request.tool_id"),
    extension_id:
      value.extension_id === null
        ? null
        : asString(value.extension_id, "request.extension_id"),
    registry_digest: asString(value.registry_digest, "request.registry_digest"),
    automation_level: asAutomationLevel(
      value.automation_level,
      "request.automation_level",
    ),
    action: {
      summary: asString(action.summary, "request.action.summary"),
      operation: asString(
        action.operation,
        "request.action.operation",
      ) as PrivilegedActionRequest["action"]["operation"],
      command: asStringArray(action.command, "request.action.command"),
      cwd: asString(action.cwd, "request.action.cwd"),
      ...(typeof action.workspace_root === "string"
        ? { workspace_root: action.workspace_root }
        : {}),
      ...(typeof action.write_target === "string"
        ? { write_target: action.write_target }
        : {}),
      ...(typeof action.write_content === "string"
        ? { write_content: action.write_content }
        : {}),
    },
    ...(Array.isArray(value.target_paths)
      ? {
          target_paths: asStringArray(
            value.target_paths,
            "request.target_paths",
          ),
        }
      : {}),
    ...(Array.isArray(value.target_resources)
      ? {
          target_resources: asStringArray(
            value.target_resources,
            "request.target_resources",
          ),
        }
      : {}),
    ...(Array.isArray(value.source_refs)
      ? {
          source_refs: asStringArray(value.source_refs, "request.source_refs"),
        }
      : {}),
    requested_capability: requestedCapability,
    ...(typeof value.dry_run_output === "string"
      ? { dry_run_output: value.dry_run_output }
      : {}),
    ...(typeof value.justification === "string"
      ? { justification: value.justification }
      : {}),
    ...(typeof value.requested_expiry_at === "string"
      ? { requested_expiry_at: value.requested_expiry_at }
      : {}),
  };
}

function validateApproval(value: unknown): ApprovalReceipt {
  if (!isRecord(value)) {
    throw new ValidationError("Approval receipt must be an object.");
  }

  if (value.contract_version !== APPROVAL_CONTRACT_VERSION) {
    throw new ValidationError(
      `approval.contract_version must be '${APPROVAL_CONTRACT_VERSION}'.`,
    );
  }

  const approver = value.approver;
  if (!isRecord(approver)) {
    throw new ValidationError("approval.approver must be an object.");
  }

  return {
    contract_version: APPROVAL_CONTRACT_VERSION,
    approval_receipt_id: asString(
      value.approval_receipt_id,
      "approval.approval_receipt_id",
    ),
    request_id: asString(value.request_id, "approval.request_id"),
    worker_id: asString(value.worker_id, "approval.worker_id"),
    assignment_id: asString(value.assignment_id, "approval.assignment_id"),
    stack_lock_digest: asString(
      value.stack_lock_digest,
      "approval.stack_lock_digest",
    ),
    tool_id: asString(value.tool_id, "approval.tool_id"),
    extension_id:
      value.extension_id === null
        ? null
        : asString(value.extension_id, "approval.extension_id"),
    registry_digest: asString(
      value.registry_digest,
      "approval.registry_digest",
    ),
    automation_level: asAutomationLevel(
      value.automation_level,
      "approval.automation_level",
    ),
    approver: {
      kind: asString(
        approver.kind,
        "approval.approver.kind",
      ) as ApprovalReceipt["approver"]["kind"],
      name: asString(approver.name, "approval.approver.name"),
    },
    approval_status: asString(
      value.approval_status,
      "approval.approval_status",
    ) as ApprovalReceipt["approval_status"],
    granted_scope:
      value.granted_scope === null
        ? null
        : validateCapabilityProfile(value.granted_scope),
    ...(typeof value.expiry_at === "string" || value.expiry_at === null
      ? { expiry_at: value.expiry_at }
      : {}),
    request_digest: asString(value.request_digest, "approval.request_digest"),
    issued_at: asString(value.issued_at, "approval.issued_at"),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function validateWriteResults(value: unknown): WriteResultRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ValidationError(`receipt.write_results[${index}] must be an object.`);
    }

    return {
      workspace_root: asString(
        entry.workspace_root,
        `receipt.write_results[${index}].workspace_root`,
      ),
      target_path: asString(
        entry.target_path,
        `receipt.write_results[${index}].target_path`,
      ),
      applied_at: asString(
        entry.applied_at,
        `receipt.write_results[${index}].applied_at`,
      ),
      ...(typeof entry.prior_sha256 === "string"
        ? { prior_sha256: entry.prior_sha256 }
        : {}),
      ...(typeof entry.backup_ref === "string"
        ? { backup_ref: entry.backup_ref }
        : {}),
    };
  });
}

function validateReceipt(value: unknown): PrivilegedActionReceipt {
  if (!isRecord(value)) {
    throw new ValidationError("Privileged action receipt must be an object.");
  }

  if (value.contract_version !== RECEIPT_CONTRACT_VERSION) {
    throw new ValidationError(
      `receipt.contract_version must be '${RECEIPT_CONTRACT_VERSION}'.`,
    );
  }

  const host = value.host;
  const requestedAction = value.requested_action;
  if (!isRecord(host)) {
    throw new ValidationError("receipt.host must be an object.");
  }
  if (!isRecord(requestedAction)) {
    throw new ValidationError("receipt.requested_action must be an object.");
  }

  return {
    contract_version: RECEIPT_CONTRACT_VERSION,
    receipt_id: asString(value.receipt_id, "receipt.receipt_id"),
    executed_at: asString(value.executed_at, "receipt.executed_at"),
    worker_id: asString(value.worker_id, "receipt.worker_id"),
    assignment_id: asString(value.assignment_id, "receipt.assignment_id"),
    stack_lock_digest: asString(
      value.stack_lock_digest,
      "receipt.stack_lock_digest",
    ),
    tool_id: asString(value.tool_id, "receipt.tool_id"),
    extension_id:
      value.extension_id === null
        ? null
        : asString(value.extension_id, "receipt.extension_id"),
    registry_digest: asString(value.registry_digest, "receipt.registry_digest"),
    automation_level: asAutomationLevel(
      value.automation_level,
      "receipt.automation_level",
    ),
    capability_profile_id: asString(
      value.capability_profile_id,
      "receipt.capability_profile_id",
    ),
    request_id: asString(value.request_id, "receipt.request_id"),
    approval_receipt_id: asString(
      value.approval_receipt_id,
      "receipt.approval_receipt_id",
    ),
    approval_status: asString(
      value.approval_status,
      "receipt.approval_status",
    ) as ApprovalReceipt["approval_status"],
    execution_mode: asString(
      value.execution_mode,
      "receipt.execution_mode",
    ) as ExecutionMode,
    host: {
      name: asString(host.name, "receipt.host.name"),
      platform: asString(host.platform, "receipt.host.platform"),
    },
    requested_action: {
      summary: asString(
        requestedAction.summary,
        "receipt.requested_action.summary",
      ),
      operation: asString(
        requestedAction.operation,
        "receipt.requested_action.operation",
      ) as PrivilegedActionRequest["action"]["operation"],
      command: asStringArray(
        requestedAction.command,
        "receipt.requested_action.command",
      ),
      cwd: asString(requestedAction.cwd, "receipt.requested_action.cwd"),
      ...(typeof requestedAction.workspace_root === "string"
        ? { workspace_root: requestedAction.workspace_root }
        : {}),
      ...(typeof requestedAction.write_target === "string"
        ? { write_target: requestedAction.write_target }
        : {}),
      ...(typeof requestedAction.write_content === "string"
        ? { write_content: requestedAction.write_content }
        : {}),
    },
    target_paths: asStringArray(value.target_paths ?? [], "receipt.target_paths"),
    target_resources: asStringArray(
      value.target_resources ?? [],
      "receipt.target_resources",
    ),
    source_refs: asStringArray(value.source_refs ?? [], "receipt.source_refs"),
    request_digest: asString(value.request_digest, "receipt.request_digest"),
    capability_profile_digest: asString(
      value.capability_profile_digest,
      "receipt.capability_profile_digest",
    ),
    approval_digest: asString(
      value.approval_digest,
      "receipt.approval_digest",
    ),
    result: asString(value.result, "receipt.result") as ResultState,
    ...(isRecord(value.failure)
      ? {
          failure: {
            category: asString(
              value.failure.category,
              "receipt.failure.category",
            ) as ReceiptFailureCategory,
            first_remediation_step: asString(
              value.failure.first_remediation_step,
              "receipt.failure.first_remediation_step",
            ),
          },
        }
      : {}),
    ...(typeof value.blocked_reason === "string"
      ? { blocked_reason: value.blocked_reason }
      : {}),
    ...(isRecord(value.inspection) ? { inspection: value.inspection as NonNullable<PrivilegedActionReceipt["inspection"]> } : {}),
    ...(isRecord(value.command_result)
      ? { command_result: value.command_result as NonNullable<PrivilegedActionReceipt["command_result"]> }
      : {}),
    ...(typeof value.execution_notes === "string"
      ? { execution_notes: value.execution_notes }
      : {}),
    ...(Array.isArray(value.write_results)
      ? (() => {
          const writeResults = validateWriteResults(value.write_results);
          return writeResults ? { write_results: writeResults } : {};
        })()
      : {}),
    ...(typeof value.supersedes_receipt_ref === "string"
      ? { supersedes_receipt_ref: value.supersedes_receipt_ref }
      : {}),
    ...(Array.isArray(value.repair_basis_refs)
      ? {
          repair_basis_refs: asStringArray(
            value.repair_basis_refs,
            "receipt.repair_basis_refs",
          ),
        }
      : {}),
    ...(typeof value.reconciled_at === "string"
      ? { reconciled_at: value.reconciled_at }
      : {}),
    ...(typeof value.reconciled_by_tool_version === "string"
      ? { reconciled_by_tool_version: value.reconciled_by_tool_version }
      : {}),
  };
}

function approvalIsExpired(approval: ApprovalReceipt): boolean {
  if (!approval.expiry_at) {
    return false;
  }

  const expiry = new Date(approval.expiry_at);
  if (Number.isNaN(expiry.getTime())) {
    throw new ValidationError(
      "approval.expiry_at is not a valid ISO timestamp.",
    );
  }

  return expiry.getTime() <= Date.now();
}

function digestValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

function buildFailureSurface(
  category: ReceiptFailureCategory,
  firstRemediationStep: string,
): NonNullable<PrivilegedActionReceipt["failure"]> {
  return {
    category,
    first_remediation_step: firstRemediationStep,
  };
}

const CONFIG_FAILURE_REMEDIATION =
  "Review the request, approval, and capability profile so they match the governed registry entry, then rerun.";
const ENVIRONMENT_FAILURE_REMEDIATION =
  "Run Lifeline from a repository root with stack.yaml and a reachable workspace, or set ATLAS_ROOT to the correct stack root.";
const RUNTIME_FAILURE_REMEDIATION =
  "Inspect the surfaced stdout, stderr, or filesystem error, fix the underlying issue, and rerun.";

function projectReceiptIdentity(
  receipt: Omit<PrivilegedActionReceipt, "receipt_id">,
): unknown {
  const {
    executed_at: _executedAt,
    host: _host,
    command_result,
    write_results,
    ...rest
  } = receipt;

  return {
    ...rest,
    ...(command_result
      ? {
          command_result: {
            command: command_result.command,
            cwd: command_result.cwd,
            exit_code: command_result.exit_code,
            stdout: normalizeCapturedText(command_result.stdout),
            stderr: normalizeCapturedText(command_result.stderr),
          },
        }
      : {}),
    ...(write_results
      ? {
          write_results: write_results.map((entry) => ({
            workspace_root: entry.workspace_root,
            target_path: entry.target_path,
            ...(entry.prior_sha256 ? { prior_sha256: entry.prior_sha256 } : {}),
          })),
        }
      : {}),
  };
}

function digestReceiptIdentity(
  receipt: Omit<PrivilegedActionReceipt, "receipt_id">,
): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(projectReceiptIdentity(receipt)), "utf8").digest("hex")}`;
}

function finalizeReceipt(
  receipt: Omit<PrivilegedActionReceipt, "receipt_id">,
): PrivilegedActionReceipt {
  const receiptId = digestReceiptIdentity(receipt);
  return {
    ...receipt,
    receipt_id: receiptId,
  };
}

function compareJson(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function uniqueStringArray(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizePath(value.trim());
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return compareJson(
    [...left].map((entry) => normalizePath(entry)),
    [...right].map((entry) => normalizePath(entry)),
  );
}

function commandBase(command: string[]): string {
  return normalizePath(command[0] ?? "").toLowerCase();
}

function commandAllowed(
  command: string[],
  capability: CapabilityProfile | null,
): boolean {
  if (!capability || !capability.process_execution_permissions.allow_spawn) {
    return false;
  }

  const base = commandBase(command);
  if (!base) {
    return false;
  }

  if (
    capability.process_execution_permissions.denied_commands.some(
      (entry) => commandBase([entry]) === base,
    )
  ) {
    return false;
  }

  if (
    capability.process_execution_permissions.allowed_commands.length > 0 &&
    !capability.process_execution_permissions.allowed_commands.some(
      (entry) => commandBase([entry]) === base,
    )
  ) {
    return false;
  }

  if (capability.process_execution_permissions.allowed_commands.length === 0) {
    return (
      capability.process_execution_permissions.allow_python &&
      /(^|\/)python(\.exe)?$/.test(base)
    );
  }

  return true;
}

function readScopeAllows(
  candidate: string,
  scope: CapabilityProfile | null,
): boolean {
  if (!scope) {
    return false;
  }

  const normalized = normalizePath(candidate);
  if (matchesAny(normalized, scope.filesystem_scopes.deny ?? [])) {
    return false;
  }

  return matchesAny(normalized, scope.filesystem_scopes.read ?? []);
}

function writeScopeAllows(
  candidate: string,
  scope: CapabilityProfile | null,
): boolean {
  if (!scope) {
    return false;
  }

  const normalized = normalizePath(candidate);
  if (matchesAny(normalized, scope.filesystem_scopes.deny ?? [])) {
    return false;
  }

  return matchesAny(normalized, scope.filesystem_scopes.write ?? []);
}

function createScopeAllows(
  candidate: string,
  scope: CapabilityProfile | null,
): boolean {
  if (!scope) {
    return false;
  }

  const normalized = normalizePath(candidate);
  if (matchesAny(normalized, scope.filesystem_scopes.deny ?? [])) {
    return false;
  }

  return matchesAny(normalized, scope.filesystem_scopes.create ?? []);
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = normalizePath(
    path.relative(path.resolve(rootPath), path.resolve(candidatePath)),
  );
  return relativePath.length === 0 || !relativePath.startsWith("..");
}

async function inspectPath(
  cwd: string,
  targetPath: string,
): Promise<InspectionRecord> {
  const absolutePath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  const relativePath = normalizePath(
    path.relative(cwd, absolutePath) || targetPath,
  );
  const stats = await stat(absolutePath).catch(() => null);

  if (!stats) {
    return { path: relativePath, exists: false, kind: "missing" };
  }

  if (stats.isDirectory()) {
    const rawEntries: Array<
      string | { name: string; isDirectory(): boolean; isFile(): boolean }
    > = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
    const entries = rawEntries.filter(
      (
        entry,
      ): entry is {
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      } => typeof entry !== "string",
    );
    return {
      path: relativePath,
      exists: true,
      kind: "directory",
      child_count: entries.length,
      entries: entries.slice(0, 20).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
      })),
    };
  }

  if (stats.isFile()) {
    const text = await readFile(absolutePath, "utf8").catch(() => null);
    if (!text) {
      return {
        path: relativePath,
        exists: true,
        kind: "file",
        size_bytes: stats.size,
      };
    }

    return {
      path: relativePath,
      exists: true,
      kind: "file",
      size_bytes: stats.size,
      sha256: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
      ...(text.includes("\u0000")
        ? {}
        : { line_count: text.split(/\r?\n/).length }),
    };
  }

  return {
    path: relativePath,
    exists: true,
    kind: "other",
    size_bytes: stats.size,
  };
}

async function sha256File(absolutePath: string): Promise<string | undefined> {
  const buffer = await readFile(absolutePath).catch(() => null);
  if (!buffer) {
    return undefined;
  }

  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function runDryRunCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  useShell: boolean,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd,
      env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };

    child.stdout.on("data", (chunk) => {
      stdout += normalizeCapturedText(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += normalizeCapturedText(String(chunk));
    });
    child.on("error", (error) => {
      stderr += normalizeCapturedText(
        error instanceof Error ? error.message : String(error),
      );
      finish(1);
    });
    child.on("exit", (code) => {
      finish(code ?? 1);
    });
  });
}

function buildBlockedReceipt(
  request: PrivilegedActionRequest,
  approval: ApprovalReceipt,
  capability: CapabilityProfile,
  executionMode: ExecutionMode,
  blockedReason: string,
  failure: NonNullable<PrivilegedActionReceipt["failure"]>,
): PrivilegedActionReceipt {
  return finalizeReceipt({
    contract_version: RECEIPT_CONTRACT_VERSION,
    executed_at: new Date().toISOString(),
    worker_id: request.worker_id,
    assignment_id: request.assignment_id,
    stack_lock_digest: request.stack_lock_digest,
    tool_id: request.tool_id,
    extension_id: request.extension_id,
    registry_digest: request.registry_digest,
    automation_level: APPROVED_AUTOMATION_LEVEL,
    capability_profile_id: capability.capability_profile_id,
    request_id: request.request_id,
    approval_receipt_id: approval.approval_receipt_id,
    approval_status: approval.approval_status,
    execution_mode: executionMode,
    host: {
      name: os.hostname(),
      platform: process.platform,
    },
    requested_action: request.action,
    target_paths: request.target_paths ?? [],
    target_resources: request.target_resources ?? [],
    source_refs: request.source_refs ?? [],
    request_digest: digestValue(request),
    capability_profile_digest: digestValue(capability),
    approval_digest: digestValue(approval),
    result: "blocked",
    failure,
    blocked_reason: blockedReason,
    execution_notes: "No execution was performed.",
  });
}

async function writeReceipt(
  receiptDir: string,
  receipt: PrivilegedActionReceipt,
): Promise<string> {
  const receiptPath = path.resolve(receiptDir, `${receipt.receipt_id}.json`);
  await writeJsonFile(receiptPath, receipt);
  return receiptPath;
}

function relativeAtlasRef(atlasRoot: string, targetPath: string): string {
  return normalizeReceiptPath(path.relative(atlasRoot, path.resolve(targetPath)));
}

function deriveSessionId(options: {
  workerId: string;
  assignmentId: string;
  sourceRefs: string[];
}): string {
  const candidates = [
    ...options.sourceRefs,
    options.assignmentId,
    options.workerId,
  ].map((value) => normalizePath(value));

  for (const candidate of candidates) {
    const sessionPathMatch = candidate.match(/runtime\/atlas\/sessions\/([^/]+)\//);
    if (sessionPathMatch?.[1]) {
      return sessionPathMatch[1];
    }

    const assignmentMatch = candidate.match(/^(session-.+)-assignment(?:[-/]|$)/);
    if (assignmentMatch?.[1]) {
      return assignmentMatch[1];
    }

    const workerMatch = candidate.match(/^(session-.+)-worker(?:[-/]|$)/);
    if (workerMatch?.[1]) {
      return workerMatch[1];
    }
  }

  return options.assignmentId.replace(/^assignment-/, "") || options.workerId.replace(/^worker-/, "");
}

async function findAtlasRoot(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  while (true) {
    const stackFile = path.join(current, "stack.yaml");
    const observationHelper = path.join(current, "ops", "atlas", "observations.py");
    if ((await pathExists(stackFile)) && (await pathExists(observationHelper))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function buildGovernedObservationDetails(options: {
  sessionId: string;
  workerId: string;
  assignmentId: string;
  stackLockDigest: string;
  toolId: string;
  extensionId: string | null;
  registryDigest: string;
  automationLevel?: AutomationLevel;
  sourceArtifactRefs: string[];
  extras?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    session_id: options.sessionId,
    worker_id: options.workerId,
    assignment_id: options.assignmentId,
    stack_lock_digest: options.stackLockDigest,
    tool_id: options.toolId,
    ...(options.extensionId ? { extension_id: options.extensionId } : {}),
    registry_digest: options.registryDigest,
    ...(options.automationLevel
      ? { automation_level: options.automationLevel }
      : {}),
    source_artifact_refs: [...new Set(options.sourceArtifactRefs)],
    ...(options.extras ?? {}),
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function emitAtlasObservation(options: {
  atlasRoot: string | null;
  observationType: string;
  sourceKind: string;
  status: string;
  sourceRef: string;
  observedAt?: string;
  scopeRef?: string;
  details: Record<string, unknown>;
}): Promise<void> {
  if (!options.atlasRoot) {
    return;
  }

  const helperPath = path.join(options.atlasRoot, "ops", "atlas", "observations.py");
  if (!(await pathExists(helperPath))) {
    return;
  }

  const args = [
    "-m",
    "ops.atlas.observations",
    "emit",
    "--root",
    options.atlasRoot,
    "--owner",
    "lifeline",
    "--observation-type",
    options.observationType,
    "--source-kind",
    options.sourceKind,
    "--status",
    options.status,
    "--source-ref",
    options.sourceRef,
    "--details-json",
    JSON.stringify(options.details),
  ];
  if (options.observedAt) {
    args.push("--observed-at", options.observedAt);
  }
  if (options.scopeRef) {
    args.push("--scope-ref", options.scopeRef);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("python", args, {
      cwd: options.atlasRoot ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if ((code ?? 1) !== 0) {
        reject(
          new Error(
            `ATLAS observation emission failed for ${options.observationType}: ${(stderr || stdout).trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function writeReceiptAndEmitObservation(options: {
  atlasRoot: string | null;
  receiptDir: string;
  receipt: PrivilegedActionReceipt;
  requestSourceRef: string;
  approvalSourceRef: string;
  sessionId: string;
  requestSourceRefs: string[];
}): Promise<string> {
  const receiptPath = await writeReceipt(options.receiptDir, options.receipt);
  const receiptSourceRef = options.atlasRoot
    ? relativeAtlasRef(options.atlasRoot, receiptPath)
    : normalizePath(receiptPath);
  const observationType =
    options.receipt.result === "succeeded"
      ? "execution_completed"
      : "execution_failed";
  const firstWriteResult = Array.isArray(options.receipt.write_results)
    ? options.receipt.write_results[0]
    : undefined;
  await emitAtlasObservation({
    atlasRoot: options.atlasRoot,
    observationType,
    sourceKind: "privileged_action_receipt",
    status: options.receipt.result,
    sourceRef: receiptSourceRef,
    observedAt: options.receipt.executed_at,
    scopeRef: options.sessionId,
    details: buildGovernedObservationDetails({
      sessionId: options.sessionId,
      workerId: options.receipt.worker_id,
      assignmentId: options.receipt.assignment_id,
      stackLockDigest: options.receipt.stack_lock_digest,
      toolId: options.receipt.tool_id,
      extensionId: options.receipt.extension_id,
      registryDigest: options.receipt.registry_digest,
      automationLevel: options.receipt.automation_level,
      sourceArtifactRefs: [
        ...options.requestSourceRefs,
        options.requestSourceRef,
        options.approvalSourceRef,
        receiptSourceRef,
      ],
      extras: {
        approval_status: options.receipt.approval_status,
        execution_mode: options.receipt.execution_mode,
        ...(firstWriteResult
          ? {
              workspace_root: firstWriteResult.workspace_root,
              target_path: firstWriteResult.target_path,
              rollback_ref: firstWriteResult.backup_ref,
              prior_sha256: firstWriteResult.prior_sha256,
            }
          : {}),
      },
    }),
  });
  return receiptPath;
}

function buildReplayRequiredResult(options: {
  originalReceiptRef: string;
  repairBasisRefs: string[];
  reason: string;
}): RepairPrivilegedActionReceiptResult {
  return {
    status: "replay_required",
    reason: options.reason,
    originalReceiptRef: options.originalReceiptRef,
    repairBasisRefs: options.repairBasisRefs,
  };
}

function ensureRepairableExecutionReceipt(options: {
  receipt: PrivilegedActionReceipt;
  request: PrivilegedActionRequest;
  approval: ApprovalReceipt;
  registry: GovernedRegistryBundle;
}): string | null {
  const { receipt, request, approval, registry } = options;
  const tool = registry.tools.get(request.tool_id);
  if (!tool) {
    return `tool_id '${request.tool_id}' is not present in the current registry.`;
  }
  if (tool.extension_id !== request.extension_id) {
    return "request extension_id does not match the current registry binding.";
  }
  if (
    !automationLevelAllows(tool.max_automation_level as AutomationLevel, request.automation_level)
  ) {
    return "request.automation_level exceeds the current registry allowance.";
  }
  if (request.registry_digest !== registry.registryDigest) {
    return "request.registry_digest does not match the current registry digest.";
  }
  if (approval.registry_digest !== registry.registryDigest) {
    return "approval.registry_digest does not match the current registry digest.";
  }
  if (receipt.request_id !== request.request_id) {
    return "receipt.request_id does not match the original request.";
  }
  if (receipt.approval_receipt_id !== approval.approval_receipt_id) {
    return "receipt.approval_receipt_id does not match the original approval.";
  }
  if (receipt.worker_id !== request.worker_id || receipt.worker_id !== approval.worker_id) {
    return "receipt.worker_id does not match the governed request and approval.";
  }
  if (receipt.assignment_id !== request.assignment_id || receipt.assignment_id !== approval.assignment_id) {
    return "receipt.assignment_id does not match the governed request and approval.";
  }
  if (receipt.tool_id !== request.tool_id || receipt.tool_id !== approval.tool_id) {
    return "receipt.tool_id does not match the governed request and approval.";
  }
  if (receipt.extension_id !== request.extension_id || receipt.extension_id !== approval.extension_id) {
    return "receipt.extension_id does not match the governed request and approval.";
  }
  if (request.stack_lock_digest !== approval.stack_lock_digest) {
    return "request.stack_lock_digest does not match the original approval.";
  }
  if (!compareJson(receipt.requested_action, request.action)) {
    return "receipt.requested_action does not match the original request action.";
  }
  if (!sameStringArray(receipt.target_paths, request.target_paths ?? [])) {
    return "receipt.target_paths do not match the original request.";
  }
  if (!sameStringArray(receipt.target_resources, request.target_resources ?? [])) {
    return "receipt.target_resources do not match the original request.";
  }
  if (receipt.approval_status !== approval.approval_status) {
    return "receipt.approval_status does not match the original approval.";
  }
  if (request.automation_level !== REQUEST_AUTOMATION_LEVEL) {
    return "request.automation_level is not request_action.";
  }
  if (approval.automation_level !== APPROVED_AUTOMATION_LEVEL) {
    return "approval.automation_level is not approved_action.";
  }
  if (receipt.automation_level !== APPROVED_AUTOMATION_LEVEL) {
    return "receipt.automation_level is not approved_action.";
  }
  if (
    receipt.capability_profile_id !== request.requested_capability.capability_profile_id
  ) {
    return "receipt.capability_profile_id does not match the original request capability.";
  }
  if (
    receipt.capability_profile_id !==
    (tool.capability_profile.capability_profile_id as string | undefined)
  ) {
    return "receipt.capability_profile_id does not match the current registry capability profile.";
  }
  if (!compareJson(request.requested_capability, tool.capability_profile)) {
    return "request.requested_capability does not match the current registry capability.";
  }
  if (
    approval.granted_scope &&
    !compareJson(approval.granted_scope, tool.capability_profile)
  ) {
    return "approval.granted_scope does not match the current registry capability.";
  }

  return null;
}

export async function repairPrivilegedActionReceipt(options: {
  originalReceiptPath: string;
  requestPath: string;
  approvalReceiptPath: string;
  sessionManifestPath: string;
  workerArtifactPaths?: string[];
  receiptDir?: string;
  reconciledAt?: string;
}): Promise<RepairPrivilegedActionReceiptResult> {
  const request = validateRequest(await loadJson(options.requestPath));
  const approval = validateApproval(await loadJson(options.approvalReceiptPath));
  const originalReceiptPayload = await loadJson(options.originalReceiptPath);
  const originalReceipt = validateReceipt({
    ...originalReceiptPayload,
    automation_level:
      originalReceiptPayload.automation_level ?? approval.automation_level,
  });
  await loadJson(options.sessionManifestPath);
  const atlasRoot =
    (await findAtlasRoot(path.dirname(options.sessionManifestPath))) ??
    (await findAtlasRoot(process.cwd()));
  const registry = await loadGovernedRegistry(
    atlasRoot ?? path.dirname(options.sessionManifestPath),
  );
  const originalReceiptRef = atlasRoot
    ? relativeAtlasRef(atlasRoot, options.originalReceiptPath)
    : normalizePath(path.resolve(options.originalReceiptPath));
  const repairBasisRefs = uniqueStringArray([
    atlasRoot ? relativeAtlasRef(atlasRoot, options.sessionManifestPath) : normalizePath(path.resolve(options.sessionManifestPath)),
    atlasRoot ? relativeAtlasRef(atlasRoot, options.requestPath) : normalizePath(path.resolve(options.requestPath)),
    atlasRoot ? relativeAtlasRef(atlasRoot, options.approvalReceiptPath) : normalizePath(path.resolve(options.approvalReceiptPath)),
    originalReceiptRef,
    ...(options.workerArtifactPaths ?? []).map((entry) =>
      atlasRoot ? relativeAtlasRef(atlasRoot, entry) : normalizePath(path.resolve(entry)),
    ),
  ]);

  const repairabilityError = ensureRepairableExecutionReceipt({
    receipt: originalReceipt,
    request,
    approval,
    registry,
  });
  if (repairabilityError) {
    const replayRequired = buildReplayRequiredResult({
      originalReceiptRef,
      repairBasisRefs,
      reason: repairabilityError,
    });
    await emitAtlasObservation({
      atlasRoot,
      observationType: "execution_replay_required",
      sourceKind: "privileged_action_receipt_repair",
      status: "replay_required",
      sourceRef: originalReceiptRef,
      observedAt: options.reconciledAt ?? new Date().toISOString(),
      scopeRef: deriveSessionId({
        workerId: originalReceipt.worker_id,
        assignmentId: originalReceipt.assignment_id,
        sourceRefs: repairBasisRefs,
      }),
      details: {
        reason: replayRequired.reason,
        repair_basis_refs: repairBasisRefs,
      },
    });
    return replayRequired;
  }

  const reconciledAt = options.reconciledAt ?? new Date().toISOString();
  const capabilityPayload =
    approval.granted_scope && compareJson(approval.granted_scope, request.requested_capability)
      ? approval.granted_scope
      : request.requested_capability;
  const repairedReceipt: PrivilegedActionReceipt = {
    receipt_id: `${originalReceipt.receipt_id}--reconciled`,
    contract_version: originalReceipt.contract_version,
    executed_at: originalReceipt.executed_at,
    worker_id: originalReceipt.worker_id,
    assignment_id: originalReceipt.assignment_id,
    stack_lock_digest: request.stack_lock_digest,
    tool_id: originalReceipt.tool_id,
    extension_id: originalReceipt.extension_id,
    registry_digest: registry.registryDigest,
    automation_level: APPROVED_AUTOMATION_LEVEL,
    capability_profile_id: originalReceipt.capability_profile_id,
    request_id: originalReceipt.request_id,
    approval_receipt_id: originalReceipt.approval_receipt_id,
    approval_status: originalReceipt.approval_status,
    execution_mode: originalReceipt.execution_mode,
    host: originalReceipt.host,
    requested_action: request.action,
    target_paths: request.target_paths ?? [],
    target_resources: request.target_resources ?? [],
    source_refs: originalReceipt.source_refs,
    request_digest: digestValue(request),
    capability_profile_digest: digestValue(capabilityPayload),
    approval_digest: digestValue(approval),
    result: originalReceipt.result,
    ...(originalReceipt.failure ? { failure: originalReceipt.failure } : {}),
    ...(originalReceipt.blocked_reason ? { blocked_reason: originalReceipt.blocked_reason } : {}),
    ...(originalReceipt.inspection ? { inspection: originalReceipt.inspection } : {}),
    ...(originalReceipt.command_result ? { command_result: originalReceipt.command_result } : {}),
    ...(originalReceipt.execution_notes ? { execution_notes: originalReceipt.execution_notes } : {}),
    ...(originalReceipt.write_results ? { write_results: originalReceipt.write_results } : {}),
    supersedes_receipt_ref: originalReceiptRef,
    repair_basis_refs: repairBasisRefs,
    reconciled_at: reconciledAt,
    reconciled_by_tool_version: RECONCILED_BY_TOOL_VERSION,
  };
  const receiptDir =
    options.receiptDir ?? path.dirname(path.resolve(options.originalReceiptPath));
  const repairedReceiptPath = await writeReceipt(receiptDir, repairedReceipt);
  const repairedReceiptRef = atlasRoot
    ? relativeAtlasRef(atlasRoot, repairedReceiptPath)
    : normalizePath(path.resolve(repairedReceiptPath));
  const sessionId = deriveSessionId({
    workerId: originalReceipt.worker_id,
    assignmentId: originalReceipt.assignment_id,
    sourceRefs: repairBasisRefs,
  });

  await emitAtlasObservation({
    atlasRoot,
    observationType: "execution_reconciled",
    sourceKind: "privileged_action_receipt_repair",
    status: "repaired",
    sourceRef: repairedReceiptRef,
    observedAt: reconciledAt,
    scopeRef: sessionId,
    details: buildGovernedObservationDetails({
      sessionId,
      workerId: originalReceipt.worker_id,
      assignmentId: originalReceipt.assignment_id,
      stackLockDigest: originalReceipt.stack_lock_digest,
      toolId: originalReceipt.tool_id,
      extensionId: originalReceipt.extension_id,
      registryDigest: repairedReceipt.registry_digest,
      automationLevel: repairedReceipt.automation_level,
      sourceArtifactRefs: repairBasisRefs,
      extras: {
        supersedes_receipt_ref: originalReceiptRef,
        reconciled_by_tool_version: RECONCILED_BY_TOOL_VERSION,
      },
    }),
  });
  return {
    status: "repaired",
    originalReceiptRef,
    repairBasisRefs,
    repairedReceipt,
    repairedReceiptPath,
    repairedReceiptRef,
  };
}

function executionModeFor(request: PrivilegedActionRequest): ExecutionMode {
  return request.action.operation === "read_only_scan"
    ? "read_only_scan"
    : request.action.operation === "scoped_write" &&
        typeof request.action.write_target === "string" &&
        typeof request.action.write_content === "string" &&
        typeof request.action.workspace_root === "string"
      ? "workspace_file_apply"
      : "dry_run_command";
}

function ensureRequestMatchesCapability(
  request: PrivilegedActionRequest,
  capability: CapabilityProfile,
): void {
  if (
    request.requested_capability.capability_profile_id !==
    capability.capability_profile_id
  ) {
    throw new ValidationError(
      "request.requested_capability.capability_profile_id must match the loaded capability profile.",
    );
  }
  if (!compareJson(request.requested_capability, capability)) {
    throw new ValidationError(
      "request.requested_capability must match the loaded capability profile.",
    );
  }
}

function ensureApprovalMatchesRequest(
  request: PrivilegedActionRequest,
  approval: ApprovalReceipt,
): void {
  if (approval.request_id !== request.request_id) {
    throw new ValidationError(
      "approval.request_id must match request.request_id.",
    );
  }
  if (approval.worker_id !== request.worker_id) {
    throw new ValidationError(
      "approval.worker_id must match request.worker_id.",
    );
  }
  if (approval.assignment_id !== request.assignment_id) {
    throw new ValidationError(
      "approval.assignment_id must match request.assignment_id.",
    );
  }
  if (approval.stack_lock_digest !== request.stack_lock_digest) {
    throw new ValidationError(
      "approval.stack_lock_digest must match request.stack_lock_digest.",
    );
  }
  if (approval.tool_id !== request.tool_id) {
    throw new ValidationError("approval.tool_id must match request.tool_id.");
  }
  if (approval.extension_id !== request.extension_id) {
    throw new ValidationError(
      "approval.extension_id must match request.extension_id.",
    );
  }
  if (approval.registry_digest !== request.registry_digest) {
    throw new ValidationError(
      "approval.registry_digest must match request.registry_digest.",
    );
  }
  if (approval.request_digest !== digestValue(request)) {
    throw new ValidationError(
      "approval.request_digest does not match the request payload.",
    );
  }
  if (request.automation_level !== REQUEST_AUTOMATION_LEVEL) {
    throw new ValidationError(
      "request.automation_level must be request_action.",
    );
  }
  if (approval.automation_level !== APPROVED_AUTOMATION_LEVEL) {
    throw new ValidationError(
      "approval.automation_level must be approved_action.",
    );
  }
}

async function validateGovernedExecution(
  request: PrivilegedActionRequest,
  approval: ApprovalReceipt,
  capability: CapabilityProfile,
  executionMode: ExecutionMode,
): Promise<string | null> {
  const registry = await loadGovernedRegistry(process.cwd());
  const tool = registry.tools.get(request.tool_id);
  if (!tool) {
    return `unknown tool_id '${request.tool_id}'.`;
  }

  if (tool.extension_id !== request.extension_id) {
    return "request extension_id does not match the registered tool binding.";
  }
  if (!automationLevelAllows(tool.max_automation_level as AutomationLevel, request.automation_level)) {
    return "request automation_level exceeds the registered tool automation policy.";
  }
  if (request.automation_level !== REQUEST_AUTOMATION_LEVEL) {
    return "request automation_level must be request_action.";
  }
  if (approval.automation_level !== APPROVED_AUTOMATION_LEVEL) {
    return "approval automation_level must be approved_action.";
  }

  if (request.extension_id) {
    const extension = registry.extensions.get(request.extension_id);
    if (!extension) {
      return `unknown extension_id '${request.extension_id}'.`;
    }
    if (extension.trust_class !== "trusted" || !extension.release_eligible) {
      return `extension '${request.extension_id}' is not trusted and release-eligible.`;
    }
  }

  if (tool.trust_class !== "trusted" || !tool.release_eligible) {
    return `tool '${request.tool_id}' is not trusted and release-eligible.`;
  }

  if (
    tool.invocation.action_operation &&
    tool.invocation.action_operation !== request.action.operation
  ) {
    return "request action.operation does not match the registered tool invocation.";
  }

  if (
    tool.invocation.execution_mode &&
    tool.invocation.execution_mode !== executionMode
  ) {
    return "execution mode does not match the registered tool invocation.";
  }

  if (executionMode === "workspace_file_apply") {
    if (request.action.command.length > 0) {
      return "workspace_file_apply requests may not declare a command.";
    }
    if (!request.action.workspace_root || !request.action.write_target) {
      return "workspace_file_apply requests must declare workspace_root and write_target.";
    }
  }

  if (!compareJson(tool.capability_profile, request.requested_capability)) {
    return "request capability profile does not match the registered tool capability.";
  }

  if (!compareJson(tool.capability_profile, capability)) {
    return "loaded capability profile does not match the registered tool capability.";
  }

  if (tool.approval.required_status && approval.approval_status !== tool.approval.required_status) {
    return "approval_status does not match the registered approval requirement.";
  }

  if (
    tool.approval.approver_kind &&
    approval.approver.kind !== tool.approval.approver_kind
  ) {
    return "approval approver kind does not match the registered approval requirement.";
  }

  if (tool.approval.granted_scope_required && !approval.granted_scope) {
    return "approval is missing the required granted_scope.";
  }

  if (
    approval.granted_scope &&
    !compareJson(tool.capability_profile, approval.granted_scope)
  ) {
    return "approval granted_scope does not match the registered tool capability.";
  }

  return null;
}

export async function executePrivilegedAction(options: {
  requestPath: string;
  capabilityProfilePath: string;
  approvalReceiptPath: string;
  receiptDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExecutionResult> {
  const capability = validateCapabilityProfile(
    await loadJson(options.capabilityProfilePath),
  );
  const request = validateRequest(await loadJson(options.requestPath));
  const approval = validateApproval(
    await loadJson(options.approvalReceiptPath),
  );
  const executionMode = executionModeFor(request);
  const receiptDir = resolvePrivilegedExecutionReceiptDirectory(
    options.receiptDir,
  );
  const atlasRoot = await findAtlasRoot(process.cwd());
  const requestSourceRef = atlasRoot
    ? relativeAtlasRef(atlasRoot, options.requestPath)
    : normalizePath(path.resolve(options.requestPath));
  const approvalSourceRef = atlasRoot
    ? relativeAtlasRef(atlasRoot, options.approvalReceiptPath)
    : normalizePath(path.resolve(options.approvalReceiptPath));
  const requestSourceRefs = (request.source_refs ?? []).map((entry) =>
    normalizePath(entry),
  );
  const sessionId = deriveSessionId({
    workerId: request.worker_id,
    assignmentId: request.assignment_id,
    sourceRefs: requestSourceRefs,
  });

  ensureRequestMatchesCapability(request, capability);
  ensureApprovalMatchesRequest(request, approval);

  await emitAtlasObservation({
    atlasRoot,
    observationType: "execution_requested",
    sourceKind: "privileged_action_request",
    status: "requested",
    sourceRef: requestSourceRef,
    observedAt: request.requested_at,
    scopeRef: sessionId,
    details: buildGovernedObservationDetails({
      sessionId,
      workerId: request.worker_id,
      assignmentId: request.assignment_id,
      stackLockDigest: request.stack_lock_digest,
      toolId: request.tool_id,
      extensionId: request.extension_id,
      registryDigest: request.registry_digest,
      automationLevel: request.automation_level,
      sourceArtifactRefs: [...requestSourceRefs, requestSourceRef],
    }),
  });

  const approvalObservationType =
    approval.approval_status === "rejected"
      ? "execution_rejected"
      : approvalIsExpired(approval)
        ? "execution_expired"
        : "execution_approved";
  const approvalObservationStatus =
    approvalObservationType === "execution_expired"
      ? "expired"
      : approval.approval_status;
  await emitAtlasObservation({
    atlasRoot,
    observationType: approvalObservationType,
    sourceKind: "approval_receipt",
    status: approvalObservationStatus,
    sourceRef: approvalSourceRef,
    observedAt: approval.issued_at,
    scopeRef: sessionId,
    details: buildGovernedObservationDetails({
      sessionId,
      workerId: approval.worker_id,
      assignmentId: approval.assignment_id,
      stackLockDigest: approval.stack_lock_digest,
      toolId: approval.tool_id,
      extensionId: approval.extension_id,
      registryDigest: approval.registry_digest,
      automationLevel: approval.automation_level,
      sourceArtifactRefs: [...requestSourceRefs, requestSourceRef, approvalSourceRef],
      extras: {
        approval_receipt_id: approval.approval_receipt_id,
        approval_status: approval.approval_status,
      },
    }),
  });

  let governedExecutionError: string | null = null;
  try {
    governedExecutionError = await validateGovernedExecution(
      request,
      approval,
      capability,
      executionMode,
      );
  } catch (error) {
    governedExecutionError =
      error instanceof Error ? error.message : String(error);
  }
  if (governedExecutionError) {
    const receipt = buildBlockedReceipt(
      request,
      approval,
      capability,
      executionMode,
      governedExecutionError,
      buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
    );
    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 1 };
  }

  const targetPaths = request.target_paths ?? [];
  const cwd = path.resolve(process.cwd(), request.action.cwd);

  if (approval.approval_status !== "approved") {
    const receipt = buildBlockedReceipt(
      request,
      approval,
      capability,
      executionMode,
      `approval_status is ${approval.approval_status}.`,
      buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
    );
    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 1 };
  }

  if (approvalIsExpired(approval)) {
    const receipt = buildBlockedReceipt(
      request,
      approval,
      capability,
      executionMode,
      "approval has expired.",
      buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
    );
    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 1 };
  }

  if (!approval.granted_scope) {
    const receipt = buildBlockedReceipt(
      request,
      approval,
      capability,
      executionMode,
      "approved actions must include a granted scope.",
      buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
    );
    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 1 };
  }

  const grantedScope = approval.granted_scope;

  if (executionMode === "read_only_scan") {
    for (const targetPath of targetPaths) {
      const absolutePath = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(cwd, targetPath);
      const relativePath = normalizePath(
        path.relative(cwd, absolutePath) || targetPath,
      );
      if (!readScopeAllows(relativePath, grantedScope)) {
        const receipt = buildBlockedReceipt(
          request,
          approval,
          capability,
          executionMode,
          `target path '${relativePath}' is outside the granted read scope.`,
          buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
        );
        const receiptPath = await writeReceiptAndEmitObservation({
          atlasRoot,
          receiptDir,
          receipt,
          requestSourceRef,
          approvalSourceRef,
          sessionId,
          requestSourceRefs,
        });
        return { receipt, receiptPath, exitCode: 1 };
      }
    }
  }

  if (executionMode === "read_only_scan") {
    const records: InspectionRecord[] = [];
    for (const targetPath of targetPaths) {
      records.push(await inspectPath(cwd, targetPath));
    }

    const receipt = finalizeReceipt({
      contract_version: RECEIPT_CONTRACT_VERSION,
      executed_at: new Date().toISOString(),
      worker_id: request.worker_id,
      assignment_id: request.assignment_id,
      stack_lock_digest: request.stack_lock_digest,
      tool_id: request.tool_id,
      extension_id: request.extension_id,
      registry_digest: request.registry_digest,
      automation_level: APPROVED_AUTOMATION_LEVEL,
      capability_profile_id: capability.capability_profile_id,
      request_id: request.request_id,
      approval_receipt_id: approval.approval_receipt_id,
      approval_status: approval.approval_status,
      execution_mode: executionMode,
      host: {
        name: os.hostname(),
        platform: process.platform,
      },
      requested_action: request.action,
      target_paths: targetPaths,
      target_resources: request.target_resources ?? [],
      source_refs: request.source_refs ?? [],
      request_digest: digestValue(request),
      capability_profile_digest: digestValue(capability),
      approval_digest: digestValue(approval),
      result: "succeeded",
      inspection: {
        cwd,
        records,
      },
      execution_notes: "Read-only filesystem inspection completed.",
    });

    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 0 };
  }

  if (executionMode === "workspace_file_apply") {
    if (!atlasRoot) {
      const receipt = buildBlockedReceipt(
        request,
        approval,
        capability,
        executionMode,
        "workspace_file_apply requires a resolved ATLAS root.",
        buildFailureSurface("environment_error", ENVIRONMENT_FAILURE_REMEDIATION),
      );
      const receiptPath = await writeReceiptAndEmitObservation({
        atlasRoot,
        receiptDir,
        receipt,
        requestSourceRef,
        approvalSourceRef,
        sessionId,
        requestSourceRefs,
      });
      return { receipt, receiptPath, exitCode: 1 };
    }

    const workspaceRootRef = normalizePath(request.action.workspace_root ?? "");
    const targetRelative = normalizePath(request.action.write_target ?? "");
    const workspaceRootPath = path.resolve(atlasRoot, workspaceRootRef);
    const targetPath = path.resolve(workspaceRootPath, targetRelative);
    const workspaceRelative = relativeAtlasRef(atlasRoot, workspaceRootPath);
    const targetPathRef = relativeAtlasRef(atlasRoot, targetPath);

    if (!isWithinRoot(workspaceRootPath, targetPath)) {
      const receipt = buildBlockedReceipt(
        request,
        approval,
        capability,
        executionMode,
        "write target escapes the declared workspace root.",
        buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
      );
      const receiptPath = await writeReceiptAndEmitObservation({
        atlasRoot,
        receiptDir,
        receipt,
        requestSourceRef,
        approvalSourceRef,
        sessionId,
        requestSourceRefs,
      });
      return { receipt, receiptPath, exitCode: 1 };
    }

    const existingTarget = await stat(targetPath).catch(() => null);
    const scopeAllowed = existingTarget
      ? writeScopeAllows(targetPathRef, grantedScope)
      : createScopeAllows(targetPathRef, grantedScope);
    if (!scopeAllowed) {
      const receipt = buildBlockedReceipt(
        request,
        approval,
        capability,
        executionMode,
        `target path '${targetPathRef}' is outside the granted workspace write scope.`,
        buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
      );
      const receiptPath = await writeReceiptAndEmitObservation({
        atlasRoot,
        receiptDir,
        receipt,
        requestSourceRef,
        approvalSourceRef,
        sessionId,
        requestSourceRefs,
      });
      return { receipt, receiptPath, exitCode: 1 };
    }

    if (
      !writeScopeAllows(workspaceRelative, grantedScope) &&
      !createScopeAllows(workspaceRelative, grantedScope)
    ) {
      const receipt = buildBlockedReceipt(
        request,
        approval,
        capability,
        executionMode,
        `workspace root '${workspaceRelative}' is outside the granted workspace scope.`,
        buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
      );
      const receiptPath = await writeReceiptAndEmitObservation({
        atlasRoot,
        receiptDir,
        receipt,
        requestSourceRef,
        approvalSourceRef,
        sessionId,
        requestSourceRefs,
      });
      return { receipt, receiptPath, exitCode: 1 };
    }

    const appliedAt = new Date().toISOString();
    const priorSha256 = existingTarget?.isFile() ? await sha256File(targetPath) : undefined;
    const backupDir = path.join(workspaceRootPath, ".rollback");
    const backupPath = existingTarget?.isFile()
      ? path.join(backupDir, `${path.basename(targetPath)}.${Date.now()}.bak`)
      : undefined;
    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (backupPath) {
        await mkdir(backupDir, { recursive: true });
        await writeFile(backupPath, await readFile(targetPath, "utf8"), "utf8");
      }
      await writeFile(targetPath, request.action.write_content ?? "", "utf8");
    } catch (error) {
      const receipt = finalizeReceipt({
        contract_version: RECEIPT_CONTRACT_VERSION,
        executed_at: appliedAt,
        worker_id: request.worker_id,
        assignment_id: request.assignment_id,
        stack_lock_digest: request.stack_lock_digest,
        tool_id: request.tool_id,
        extension_id: request.extension_id,
        registry_digest: request.registry_digest,
        automation_level: APPROVED_AUTOMATION_LEVEL,
        capability_profile_id: capability.capability_profile_id,
        request_id: request.request_id,
        approval_receipt_id: approval.approval_receipt_id,
        approval_status: approval.approval_status,
        execution_mode: executionMode,
        host: {
          name: os.hostname(),
          platform: process.platform,
        },
        requested_action: request.action,
        target_paths: targetPaths,
        target_resources: request.target_resources ?? [],
        source_refs: request.source_refs ?? [],
        request_digest: digestValue(request),
        capability_profile_digest: digestValue(capability),
        approval_digest: digestValue(approval),
        result: "failed",
        failure: buildFailureSurface(
          "runtime_error",
          RUNTIME_FAILURE_REMEDIATION,
        ),
        execution_notes:
          error instanceof Error
            ? `Workspace file apply failed: ${error.message}`
            : `Workspace file apply failed: ${String(error)}`,
      });
      const receiptPath = await writeReceiptAndEmitObservation({
        atlasRoot,
        receiptDir,
        receipt,
        requestSourceRef,
        approvalSourceRef,
        sessionId,
        requestSourceRefs,
      });
      return { receipt, receiptPath, exitCode: 1 };
    }

    const receipt = finalizeReceipt({
      contract_version: RECEIPT_CONTRACT_VERSION,
      executed_at: appliedAt,
      worker_id: request.worker_id,
      assignment_id: request.assignment_id,
      stack_lock_digest: request.stack_lock_digest,
      tool_id: request.tool_id,
      extension_id: request.extension_id,
      registry_digest: request.registry_digest,
      automation_level: APPROVED_AUTOMATION_LEVEL,
      capability_profile_id: capability.capability_profile_id,
      request_id: request.request_id,
      approval_receipt_id: approval.approval_receipt_id,
      approval_status: approval.approval_status,
      execution_mode: executionMode,
      host: {
        name: os.hostname(),
        platform: process.platform,
      },
      requested_action: request.action,
      target_paths: targetPaths,
      target_resources: request.target_resources ?? [],
      source_refs: request.source_refs ?? [],
      request_digest: digestValue(request),
      capability_profile_digest: digestValue(capability),
      approval_digest: digestValue(approval),
      result: "succeeded",
      write_results: [
        {
          workspace_root: workspaceRelative,
          target_path: targetPathRef,
          applied_at: appliedAt,
          ...(priorSha256 ? { prior_sha256: priorSha256 } : {}),
        },
      ],
      execution_notes: "Workspace file apply completed inside the declared session-owned workspace root.",
    });
    if (backupPath) {
      const writeResult = receipt.write_results?.[0];
      if (!writeResult) {
        throw new Error(
          "workspace_file_apply receipt is missing write_results[0] after finalization.",
        );
      }
      receipt.write_results = [
        {
          ...writeResult,
          backup_ref: relativeAtlasRef(atlasRoot, backupPath),
        },
      ];
    }

    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 0 };
  }

  if (!commandAllowed(request.action.command, grantedScope)) {
    const receipt = buildBlockedReceipt(
      request,
      approval,
      capability,
      executionMode,
      "requested command is not allowed by the granted execution scope.",
      buildFailureSurface("config_error", CONFIG_FAILURE_REMEDIATION),
    );
    const receiptPath = await writeReceiptAndEmitObservation({
      atlasRoot,
      receiptDir,
      receipt,
      requestSourceRef,
      approvalSourceRef,
      sessionId,
      requestSourceRefs,
    });
    return { receipt, receiptPath, exitCode: 1 };
  }

  const commandResult = await runDryRunCommand(
    request.action.command,
    cwd,
    options.env ?? process.env,
    Boolean(grantedScope.process_execution_permissions.allow_shell),
  );

  const result: ResultState =
    commandResult.exitCode === 0 ? "succeeded" : "failed";
  const receipt = finalizeReceipt({
    contract_version: RECEIPT_CONTRACT_VERSION,
    executed_at: new Date().toISOString(),
    worker_id: request.worker_id,
    assignment_id: request.assignment_id,
    stack_lock_digest: request.stack_lock_digest,
    tool_id: request.tool_id,
    extension_id: request.extension_id,
    registry_digest: request.registry_digest,
    automation_level: APPROVED_AUTOMATION_LEVEL,
    capability_profile_id: capability.capability_profile_id,
    request_id: request.request_id,
    approval_receipt_id: approval.approval_receipt_id,
    approval_status: approval.approval_status,
    execution_mode: executionMode,
    host: {
      name: os.hostname(),
      platform: process.platform,
    },
    requested_action: request.action,
    target_paths: targetPaths,
    target_resources: request.target_resources ?? [],
    source_refs: request.source_refs ?? [],
    request_digest: digestValue(request),
    capability_profile_digest: digestValue(capability),
    approval_digest: digestValue(approval),
    result,
    command_result: {
      command: request.action.command,
      cwd,
      exit_code: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
    },
    ...(result === "failed"
      ? {
          failure: buildFailureSurface(
            "runtime_error",
            RUNTIME_FAILURE_REMEDIATION,
          ),
        }
      : {}),
    execution_notes:
      result === "succeeded"
        ? "Dry-run command completed without mutation authority."
        : "Dry-run command returned a non-zero exit code.",
  });

  const receiptPath = await writeReceiptAndEmitObservation({
    atlasRoot,
    receiptDir,
    receipt,
    requestSourceRef,
    approvalSourceRef,
    sessionId,
    requestSourceRefs,
  });
  return { receipt, receiptPath, exitCode: result === "succeeded" ? 0 : 1 };
}

export function resolvePrivilegedExecutionReceiptDirectory(
  receiptDir?: string,
): string {
  return receiptDir ?? getLifelineReceiptsDirectory();
}
