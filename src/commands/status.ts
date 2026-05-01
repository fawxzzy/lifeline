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
    receipts_dir: string;
    latest_receipts: Array<{
      receipt_id: string;
      action: string;
      status: string;
      release_id: string;
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
        receipts_dir: snapshot.release.receiptsDir,
        latest_receipts: snapshot.release.latestReceipts.map((receipt) => ({
          receipt_id: receipt.receiptId,
          action: receipt.action,
          status: receipt.status,
          release_id: receipt.releaseId,
          path: receipt.path,
        })),
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
