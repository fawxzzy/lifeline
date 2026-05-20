import {
  findListeningPortOwnerPid,
  isProcessAlive,
} from "../core/process-manager.js";
import { readReleaseOperatorEvidence } from "../core/release-state.js";
import { checkHealth } from "../core/healthcheck.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

type StatusMode = "standard" | "proof-json" | "proof-text";

type StatusCommandOptions = {
  mode?: StatusMode;
  enforceProofGate?: boolean;
};

type RuntimeSnapshot = {
  appName: string;
  supervisorAlive: boolean;
  wrapperAlive: boolean;
  listenerAlive: boolean;
  managedChildAlive: boolean;
  managedPortOwner: boolean;
  inferredManagedPid: number | undefined;
  portOwnerPid: number | undefined;
  health: {
    ok: boolean;
    error?: string;
    status?: number;
  };
  release?: Awaited<ReturnType<typeof readReleaseOperatorEvidence>>;
};

type ProofState = "ready" | "blocked" | "conflicted" | "not-ready";
type ProofDecision =
  | "parallel_guard_ready"
  | "parallel_guard_blocked"
  | "parallel_guard_conflicted"
  | "parallel_guard_not_ready";

const ExitCode = {
  Success: 0,
  Failure: 1,
} as const;

function deriveProof(snapshot: RuntimeSnapshot): {
  ok: boolean;
  state: ProofState;
  reasons: string[];
} {
  if (
    snapshot.supervisorAlive &&
    snapshot.health.ok &&
    snapshot.managedChildAlive &&
    snapshot.managedPortOwner
  ) {
    return {
      ok: true,
      state: "ready",
      reasons: ["supervisor, managed child, port ownership, and healthcheck are healthy"],
    };
  }

  if (snapshot.portOwnerPid && !snapshot.managedPortOwner) {
    return {
      ok: false,
      state: "blocked",
      reasons: [`port is occupied by non-managed pid ${snapshot.portOwnerPid}`],
    };
  }

  if (snapshot.supervisorAlive && snapshot.managedChildAlive && !snapshot.health.ok) {
    return {
      ok: false,
      state: "conflicted",
      reasons: [snapshot.health.error ?? "healthcheck failed while managed process is alive"],
    };
  }

  return {
    ok: false,
    state: "not-ready",
    reasons: [
      !snapshot.supervisorAlive ? "supervisor is not running" : "managed app process is not running",
    ],
  };
}

function formatReceiptHealthSummary(
  health: NonNullable<RuntimeSnapshot["release"]>["receiptHealth"],
): string {
  if (health.status === "ok") {
    return "ok";
  }

  const reasons = [];
  if (health.versionMismatchCount > 0) {
    reasons.push(`versionMismatch=${health.versionMismatchCount}`);
  }
  if (health.invalidReceiptCount > 0) {
    reasons.push(`invalid=${health.invalidReceiptCount}`);
  }
  if (health.unreadableReceiptCount > 0) {
    reasons.push(`unreadable=${health.unreadableReceiptCount}`);
  }
  if (health.missingLatestReceipt) {
    reasons.push("missingLatestReceipt=yes");
  }

  return reasons.length > 0
    ? `degraded (${reasons.join(", ")})`
    : "degraded";
}

function serializeProofPayload(snapshot: RuntimeSnapshot): {
  mode: "proof";
  proof: {
    ok: boolean;
    state: ProofState;
    reasons: string[];
  };
  parallel_work: string[];
  runtime: {
    app: string;
    status: string;
    supervisor_alive: boolean;
    child_alive: boolean;
    listener_alive: boolean;
    managed_port_owner: boolean;
    port_owner_pid?: number;
    managed_pid?: number;
    health: {
      ok: boolean;
      status?: number;
      error?: string;
    };
  };
  release?: {
    current_release_id?: string;
    current_artifact_ref?: string;
    previous_release_id?: string;
    rollback_target?: {
      release_id: string;
      artifact_ref: string;
      strategy: string;
      note?: string;
    };
    rollback_ready: boolean;
    rollback_confidence: {
      status: string;
      issues: string[];
      replayed_previous_release_id?: string;
      replayed_previous_artifact_ref?: string;
    };
    receipt_health: {
      status: string;
      contract_version: string;
      valid_receipt_count: number;
      version_mismatch_count: number;
      invalid_receipt_count: number;
      unreadable_receipt_count: number;
      missing_latest_receipt: boolean;
    };
    latest_receipt?: {
      receipt_id: string;
      action: string;
      status: string;
      release_id: string;
      contract_version: string;
      path: string;
    };
    latest_rollback_receipt?: {
      receipt_id: string;
      action: string;
      status: string;
      release_id: string;
      contract_version: string;
      path: string;
    };
    replay_verification: {
      ok: boolean;
      issue_count: number;
      issues: string[];
      applied_receipts: number;
      replayed_current_release_id?: string;
      replayed_previous_release_id?: string;
    };
    receipts_dir: string;
    latest_receipts: Array<{
      receipt_id: string;
      action: string;
      status: string;
      release_id: string;
      contract_version: string;
      path: string;
    }>;
  };
} {
  const proof = deriveProof(snapshot);
  const release = snapshot.release
    ? {
        ...(snapshot.release.current
          ? {
              current_release_id: snapshot.release.current.releaseId,
              ...(snapshot.release.current.artifactRef
                ? { current_artifact_ref: snapshot.release.current.artifactRef }
                : {}),
            }
          : {}),
        ...(snapshot.release.previous
          ? { previous_release_id: snapshot.release.previous.releaseId }
          : {}),
        ...(snapshot.release.rollbackTarget
          ? {
              rollback_target: {
                release_id: snapshot.release.rollbackTarget.releaseId,
                artifact_ref: snapshot.release.rollbackTarget.artifactRef,
                strategy: snapshot.release.rollbackTarget.strategy,
                ...(snapshot.release.rollbackTarget.note
                  ? { note: snapshot.release.rollbackTarget.note }
                  : {}),
              },
            }
          : {}),
        rollback_ready: snapshot.release.rollbackReady,
        rollback_confidence: {
          status: snapshot.release.rollbackConfidence.status,
          issues: snapshot.release.rollbackConfidence.issues,
          ...(snapshot.release.rollbackConfidence.replayedPreviousReleaseId
            ? {
                replayed_previous_release_id:
                  snapshot.release.rollbackConfidence.replayedPreviousReleaseId,
              }
            : {}),
          ...(snapshot.release.rollbackConfidence.replayedPreviousArtifactRef
            ? {
                replayed_previous_artifact_ref:
                  snapshot.release.rollbackConfidence.replayedPreviousArtifactRef,
              }
            : {}),
        },
        receipt_health: {
          status: snapshot.release.receiptHealth.status,
          contract_version: snapshot.release.receiptHealth.contractVersion,
          valid_receipt_count: snapshot.release.receiptHealth.validReceiptCount,
          version_mismatch_count:
            snapshot.release.receiptHealth.versionMismatchCount,
          invalid_receipt_count: snapshot.release.receiptHealth.invalidReceiptCount,
          unreadable_receipt_count:
            snapshot.release.receiptHealth.unreadableReceiptCount,
          missing_latest_receipt:
            snapshot.release.receiptHealth.missingLatestReceipt,
        },
        replay_verification: {
          ok: snapshot.release.replayVerification.ok,
          issue_count: snapshot.release.replayVerification.issueCount,
          issues: snapshot.release.replayVerification.issues,
          applied_receipts: snapshot.release.replayVerification.appliedReceipts,
          ...(snapshot.release.replayVerification.replayedCurrentReleaseId
            ? {
                replayed_current_release_id:
                  snapshot.release.replayVerification.replayedCurrentReleaseId,
              }
            : {}),
          ...(snapshot.release.replayVerification.replayedPreviousReleaseId
            ? {
                replayed_previous_release_id:
                  snapshot.release.replayVerification.replayedPreviousReleaseId,
              }
            : {}),
        },
        receipts_dir: snapshot.release.receiptsDir,
        latest_receipts: snapshot.release.latestReceipts.map((receipt) => ({
          receipt_id: receipt.receiptId,
          action: receipt.action,
          status: receipt.status,
          release_id: receipt.releaseId,
          contract_version: receipt.contractVersion,
          path: receipt.path,
        })),
        ...(snapshot.release.latestReceipt
          ? {
              latest_receipt: {
                receipt_id: snapshot.release.latestReceipt.receiptId,
                action: snapshot.release.latestReceipt.action,
                status: snapshot.release.latestReceipt.status,
                release_id: snapshot.release.latestReceipt.releaseId,
                contract_version: snapshot.release.latestReceipt.contractVersion,
                path: snapshot.release.latestReceipt.path,
              },
            }
          : {}),
        ...(snapshot.release.latestRollbackReceipt
          ? {
              latest_rollback_receipt: {
                receipt_id: snapshot.release.latestRollbackReceipt.receiptId,
                action: snapshot.release.latestRollbackReceipt.action,
                status: snapshot.release.latestRollbackReceipt.status,
                release_id: snapshot.release.latestRollbackReceipt.releaseId,
                contract_version:
                  snapshot.release.latestRollbackReceipt.contractVersion,
                path: snapshot.release.latestRollbackReceipt.path,
              },
            }
          : {}),
      }
    : undefined;

  return {
    mode: "proof",
    proof,
    parallel_work: [],
    runtime: {
      app: snapshot.appName,
      status: proof.state,
      supervisor_alive: snapshot.supervisorAlive,
      child_alive: snapshot.managedChildAlive,
      listener_alive: snapshot.listenerAlive,
      managed_port_owner: snapshot.managedPortOwner,
      ...(snapshot.portOwnerPid ? { port_owner_pid: snapshot.portOwnerPid } : {}),
      ...(snapshot.inferredManagedPid ? { managed_pid: snapshot.inferredManagedPid } : {}),
      health: {
        ok: snapshot.health.ok,
        ...(snapshot.health.status ? { status: snapshot.health.status } : {}),
        ...(snapshot.health.error ? { error: snapshot.health.error } : {}),
      },
    },
    ...(release ? { release } : {}),
  };
}

function mapProofDecision(state: ProofState): ProofDecision {
  switch (state) {
    case "ready":
      return "parallel_guard_ready";
    case "blocked":
      return "parallel_guard_blocked";
    case "conflicted":
      return "parallel_guard_conflicted";
    case "not-ready":
      return "parallel_guard_not_ready";
  }
}

function printProofText(payload: ReturnType<typeof serializeProofPayload>): void {
  const decision = mapProofDecision(payload.proof.state);

  console.log(`Proof status for ${payload.runtime.app}: ${payload.proof.state}`);
  console.log(`Decision: ${decision}`);
  console.log(`- proof.ok: ${payload.proof.ok}`);
  console.log(`- reasons: ${payload.proof.reasons.join("; ")}`);
  console.log(`- supervisorAlive: ${payload.runtime.supervisor_alive}`);
  console.log(`- childAlive: ${payload.runtime.child_alive}`);
  console.log(`- managedPortOwner: ${payload.runtime.managed_port_owner}`);
  console.log(
    `- health: ${payload.runtime.health.ok ? `ok (${payload.runtime.health.status ?? 200})` : (payload.runtime.health.error ?? "failed")}`,
  );
  if (payload.release?.current_release_id) {
    console.log(`- currentReleaseId: ${payload.release.current_release_id}`);
  }
  if (payload.release?.previous_release_id) {
    console.log(`- previousReleaseId: ${payload.release.previous_release_id}`);
  }
  if (payload.release?.rollback_target) {
    console.log(
      `- rollbackTarget: ${payload.release.rollback_target.release_id} (${payload.release.rollback_target.strategy})`,
    );
  }
  if (payload.release) {
    console.log(`- rollbackReady: ${payload.release.rollback_ready ? "yes" : "no"}`);
    console.log(`- rollbackConfidence: ${payload.release.rollback_confidence.status}`);
    console.log(
      `- receiptContractVersion: ${payload.release.receipt_health.contract_version}`,
    );
    console.log(
      `- receiptHealth: ${formatReceiptHealthSummary({
        status: payload.release.receipt_health.status as "ok" | "degraded",
        contractVersion: payload.release.receipt_health.contract_version,
        validReceiptCount: payload.release.receipt_health.valid_receipt_count,
        versionMismatchCount: payload.release.receipt_health.version_mismatch_count,
        invalidReceiptCount: payload.release.receipt_health.invalid_receipt_count,
        unreadableReceiptCount: payload.release.receipt_health.unreadable_receipt_count,
        missingLatestReceipt: payload.release.receipt_health.missing_latest_receipt,
      })}`,
    );
    console.log(
      `- releaseReplay: ${payload.release.replay_verification.ok ? "verified" : "degraded"} (${payload.release.replay_verification.applied_receipts} receipts applied)`,
    );
  }
  if (
    payload.release &&
    payload.release.rollback_confidence.issues.length > 0
  ) {
    console.log(
      `- rollbackConfidenceIssues: ${payload.release.rollback_confidence.issues.join("; ")}`,
    );
  }
  if (payload.release?.latest_receipt) {
    const receipt = payload.release.latest_receipt;
    console.log(
      `- latestReceipt: ${receipt.receipt_id} ${receipt.action} ${receipt.status} ${receipt.release_id} (${receipt.path})`,
    );
  }
  if (payload.release?.latest_rollback_receipt) {
    const receipt = payload.release.latest_rollback_receipt;
    console.log(
      `- latestRollbackReceipt: ${receipt.action} ${receipt.status} ${receipt.release_id} (${receipt.path})`,
    );
  }
  if (
    payload.release &&
    !payload.release.replay_verification.ok &&
    payload.release.replay_verification.issues.length > 0
  ) {
    console.log(
      `- releaseReplayIssues: ${payload.release.replay_verification.issues.join("; ")}`,
    );
  }
}

function resolveProofExitCode(
  payload: ReturnType<typeof serializeProofPayload>,
  enforceProofGate: boolean,
): number {
  // Proof-mode reporting is intentionally fail-open so operators can always
  // inspect blocked/conflicted/not-ready payloads and briefs.
  if (!enforceProofGate) {
    return ExitCode.Success;
  }

  // Proof-gate is explicit fail-closed policy enforcement.
  return payload.proof.ok ? ExitCode.Success : ExitCode.Failure;
}

export async function runStatusCommand(
  appName: string,
  options: StatusCommandOptions = {},
): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const supervisorAlive = await isProcessAlive(state.supervisorPid);
  const wrapperAlive = state.wrapperPid
    ? await isProcessAlive(state.wrapperPid)
    : false;
  const listenerAlive = state.listenerPid
    ? await isProcessAlive(state.listenerPid)
    : false;
  const portOwnerPid = await findListeningPortOwnerPid(state.port);

  const inferredManagedPid = state.childPid ?? state.listenerPid;
  const managedChildAlive = inferredManagedPid ? await isProcessAlive(inferredManagedPid) : false;
  const managedPortOwner =
    Boolean(portOwnerPid) &&
    Boolean(
      (state.childPid && portOwnerPid === state.childPid) ||
        (state.listenerPid && portOwnerPid === state.listenerPid),
    );

  if (!supervisorAlive) {
    if (portOwnerPid) {
      state.lastKnownStatus = "blocked";
      state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
    } else {
      state.lastKnownStatus = state.crashLoopDetected ? "crash-loop" : "stopped";
      state.blockedReason = undefined;
    }
  }

  const shouldCheckHealth = Boolean(portOwnerPid || managedChildAlive);
  const health = shouldCheckHealth
    ? await checkHealth(state.port, state.healthcheckPath)
    : { ok: false, error: "managed app process not running" };

  if (supervisorAlive && health.ok && managedChildAlive && managedPortOwner) {
    state.lastKnownStatus = "running";
    state.childPid = inferredManagedPid;
    state.listenerPid = portOwnerPid ?? state.listenerPid;
    state.blockedReason = undefined;
  } else if (supervisorAlive && managedPortOwner && !health.ok) {
    state.lastKnownStatus = "unhealthy";
    state.listenerPid = portOwnerPid ?? state.listenerPid;
    state.blockedReason = undefined;
  } else if (supervisorAlive && !managedChildAlive && portOwnerPid) {
    state.lastKnownStatus = "blocked";
    state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
  } else if (supervisorAlive) {
    state.lastKnownStatus = "stopped";
    state.blockedReason = undefined;
  }

  state.portOwnerPid = portOwnerPid;
  await upsertAppState(state);
  const releaseEvidence = await readReleaseOperatorEvidence(appName);

  const runtimeSnapshot: RuntimeSnapshot = {
    appName,
    supervisorAlive,
    wrapperAlive,
    listenerAlive,
    managedChildAlive,
    managedPortOwner,
    inferredManagedPid,
    portOwnerPid,
    health,
    release: releaseEvidence,
  };

  if (options.mode === "proof-json" || options.mode === "proof-text") {
    // Render state first (JSON payload or operator brief), enforce policy second.
    // This guarantees proof payload/brief visibility regardless of proof.ok.
    const payload = serializeProofPayload(runtimeSnapshot);

    if (options.mode === "proof-json") {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printProofText(payload);
    }

    return resolveProofExitCode(payload, Boolean(options.enforceProofGate));
  }

  console.log(`App ${appName} is ${state.lastKnownStatus}.`);
  console.log(
    `- supervisor: ${supervisorAlive ? `alive (pid ${state.supervisorPid})` : `stopped (pid ${state.supervisorPid})`}`,
  );
  console.log(
    `- child: ${managedChildAlive ? `alive (pid ${inferredManagedPid})` : "stopped"}`,
  );
  console.log(
    `- wrapper: ${wrapperAlive ? `alive (pid ${state.wrapperPid})` : "stopped"}`,
  );
  console.log(
    `- listener: ${listenerAlive ? `alive (pid ${state.listenerPid})` : "unknown/stopped"}`,
  );
  console.log(`- portOwner: ${portOwnerPid ? `pid ${portOwnerPid}` : "none"}`);
  console.log(`- startedAt: ${state.startedAt}`);
  console.log(`- port: ${state.port}`);
  console.log(`- log: ${state.logPath}`);
  console.log(`- manifest: ${state.manifestPath}`);
  if (state.playbookPath) {
    console.log(`- playbook: ${state.playbookPath}`);
  }
  if (releaseEvidence?.current) {
    console.log(`- currentReleaseId: ${releaseEvidence.current.releaseId}`);
    if (releaseEvidence.current.artifactRef) {
      console.log(`- currentArtifactRef: ${releaseEvidence.current.artifactRef}`);
    }
    if (releaseEvidence.current.metadataPath) {
      console.log(`- releaseMetadata: ${releaseEvidence.current.metadataPath}`);
    }
  }
  if (releaseEvidence?.previous) {
    console.log(`- previousReleaseId: ${releaseEvidence.previous.releaseId}`);
    if (releaseEvidence.previous.artifactRef) {
      console.log(`- previousArtifactRef: ${releaseEvidence.previous.artifactRef}`);
    }
  }
  if (releaseEvidence?.rollbackTarget) {
    console.log(
      `- rollbackTarget.releaseId: ${releaseEvidence.rollbackTarget.releaseId}`,
    );
    console.log(
      `- rollbackTarget.artifactRef: ${releaseEvidence.rollbackTarget.artifactRef}`,
    );
    console.log(
      `- rollbackTarget.strategy: ${releaseEvidence.rollbackTarget.strategy}`,
    );
  }
  if (releaseEvidence) {
    console.log(`- rollbackReady: ${releaseEvidence.rollbackReady ? "yes" : "no"}`);
    console.log(`- rollbackConfidence: ${releaseEvidence.rollbackConfidence.status}`);
    console.log(
      `- receiptContractVersion: ${releaseEvidence.receiptHealth.contractVersion}`,
    );
    console.log(
      `- receiptHealth: ${formatReceiptHealthSummary(releaseEvidence.receiptHealth)}`,
    );
    console.log(
      `- releaseReplay: ${releaseEvidence.replayVerification.ok ? "verified" : "degraded"} (${releaseEvidence.replayVerification.appliedReceipts} receipts applied)`,
    );
  }
  if (
    releaseEvidence &&
    releaseEvidence.rollbackConfidence.issues.length > 0
  ) {
    console.log(
      `- rollbackConfidenceIssues: ${releaseEvidence.rollbackConfidence.issues.join("; ")}`,
    );
  }
  if (releaseEvidence?.latestReceipt) {
    console.log(
      `- latestReceipt: ${releaseEvidence.latestReceipt.receiptId} ${releaseEvidence.latestReceipt.action} ${releaseEvidence.latestReceipt.status} ${releaseEvidence.latestReceipt.releaseId} (${releaseEvidence.latestReceipt.path})`,
    );
  }
  if (releaseEvidence?.latestRollbackReceipt) {
    console.log(
      `- latestRollbackReceipt: ${releaseEvidence.latestRollbackReceipt.action} ${releaseEvidence.latestRollbackReceipt.status} ${releaseEvidence.latestRollbackReceipt.releaseId} (${releaseEvidence.latestRollbackReceipt.path})`,
    );
  }
  if (
    releaseEvidence &&
    !releaseEvidence.replayVerification.ok &&
    releaseEvidence.replayVerification.issues.length > 0
  ) {
    console.log(
      `- releaseReplayIssues: ${releaseEvidence.replayVerification.issues.join("; ")}`,
    );
  }
  if (releaseEvidence?.latestReceipts.length) {
    console.log(`- receiptsDir: ${releaseEvidence.receiptsDir}`);
    for (const receipt of releaseEvidence.latestReceipts) {
      console.log(
        `- receipt: ${receipt.action} ${receipt.status} ${receipt.releaseId} (${receipt.path})`,
      );
    }
  }
  console.log(`- restartPolicy: ${state.restartPolicy}`);
  console.log(`- restartCount: ${state.restartCount}`);
  console.log(`- crashLoopDetected: ${state.crashLoopDetected}`);
  if (state.blockedReason) {
    console.log(`- blockedReason: ${state.blockedReason}`);
  }
  if (state.lastExitCode !== undefined) {
    console.log(`- lastExitCode: ${state.lastExitCode}`);
  }
  if (state.lastExitAt) {
    console.log(`- lastExitAt: ${state.lastExitAt}`);
  }
  console.log(
    `- healthcheck: http://127.0.0.1:${state.port}${state.healthcheckPath}`,
  );
  console.log(
    `- health: ${health.ok ? `ok (${health.status ?? 200})` : (health.error ?? "failed")}`,
  );

  return supervisorAlive && health.ok && managedChildAlive && managedPortOwner
    ? ExitCode.Success
    : ExitCode.Failure;
}
