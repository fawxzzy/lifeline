import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  activateWave1Release,
  persistWave1Release,
  rollbackWave1Release,
} from "../control-plane/wave1-release-engine.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSourceDir = path.join(repoRoot, "fixtures", "runtime-smoke-app");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const appName = "runtime-smoke-app";

function runCli(args, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd,
      env: process.env,
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

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `Command failed: node ${cliPath} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assertIncludes(output, fragment, label) {
  assert(
    output.includes(fragment),
    `${label}; expected to find ${JSON.stringify(fragment)} in output:\n${output}`,
  );
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Expected a numeric local port.")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function createDisposableFixtureRoot(port) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-release-evidence-fixture-"));
  const manifestPath = path.join(tempRoot, `${appName}.lifeline.yml`);

  await copyFile(path.join(fixtureSourceDir, "server.js"), path.join(tempRoot, "server.js"));

  const envSource = await readFile(path.join(fixtureSourceDir, ".env.runtime"), "utf8");
  const envContent = envSource.replace(/^PORT=.*$/m, `PORT=${port}`);
  await writeFile(path.join(tempRoot, ".env.runtime"), envContent, "utf8");

  const manifestSource = await readFile(
    path.join(fixtureSourceDir, `${appName}.lifeline.yml`),
    "utf8",
  );
  const manifestContent = manifestSource.replace(/^port:\s*\d+$/m, `port: ${port}`);
  await writeFile(manifestPath, manifestContent, "utf8");

  return { tempRoot, manifestPath };
}

function createReleaseManifest({ artifactRef, rollbackReleaseId, rollbackArtifactRef, port }) {
  return {
    contractVersion: "atlas.lifeline.deploy-contract.v1",
    appName,
    artifactRef,
    route: {
      domain: `${appName}.lifeline.internal`,
      path: "/",
    },
    envRefs: [],
    healthcheckPath: "/healthz",
    migrationHooks: {
      preDeploy: ["pnpm verify"],
      postDeploy: ["pnpm smoke:release"],
      rollback: ["pnpm rollback:release"],
    },
    rollbackTarget: {
      releaseId: rollbackReleaseId,
      artifactRef: rollbackArtifactRef,
      strategy: "restore",
      note: `rollback ${appName} on port ${port}`,
    },
  };
}

async function removeTreeWithRetries(targetPath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      const isBusy =
        error instanceof Error &&
        "code" in error &&
        (error.code === "EBUSY" || error.code === "ENOTEMPTY");
      if (!isBusy || attempt === 5) {
        return false;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 200 * (attempt + 1));
      });
    }
  }

  return false;
}

const tempWorkspace = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-release-evidence-workspace-"),
);
const port = await getFreePort();
const { tempRoot: fixtureRoot, manifestPath } = await createDisposableFixtureRoot(port);

let cleanupNeeded = true;

try {
  const upResult = await runCli(["up", manifestPath], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(upResult.code, 0, `up: expected exit 0, got ${upResult.code}\n${upResult.stdout}\n${upResult.stderr}`);

  const releaseA = await persistWave1Release(
    createReleaseManifest({
      artifactRef: "docker://runtime-smoke-app:release-a",
      rollbackReleaseId: "bootstrap-release",
      rollbackArtifactRef: "docker://runtime-smoke-app:bootstrap",
      port,
    }),
    {
      rootDir: tempWorkspace,
      releaseId: "release-runtime-smoke-app-a",
      createdAt: "2026-04-26T00:00:00.000Z",
      receiptAt: "2026-04-26T00:00:00.000Z",
    },
  );
  await activateWave1Release(tempWorkspace, appName, releaseA.releaseId, {
    receiptAt: "2026-04-26T00:01:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  const releaseB = await persistWave1Release(
    createReleaseManifest({
      artifactRef: "docker://runtime-smoke-app:release-b",
      rollbackReleaseId: releaseA.releaseId,
      rollbackArtifactRef: releaseA.releaseMetadata.artifactRef,
      port,
    }),
    {
      rootDir: tempWorkspace,
      releaseId: "release-runtime-smoke-app-b",
      createdAt: "2026-04-26T00:02:00.000Z",
      receiptAt: "2026-04-26T00:02:00.000Z",
    },
  );
  await activateWave1Release(tempWorkspace, appName, releaseB.releaseId, {
    receiptAt: "2026-04-26T00:03:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });
  await rollbackWave1Release(tempWorkspace, appName, {
    receiptAt: "2026-04-26T00:04:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });
  await activateWave1Release(tempWorkspace, appName, releaseB.releaseId, {
    receiptAt: "2026-04-26T00:05:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  const statusResult = await runCli(["status", appName], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    statusResult.code,
    0,
    `status: expected exit 0, got ${statusResult.code}\n${statusResult.stdout}\n${statusResult.stderr}`,
  );
  assertIncludes(statusResult.stdout, "- currentReleaseId: release-runtime-smoke-app-b", "status: missing current release id");
  assertIncludes(statusResult.stdout, "- previousReleaseId: release-runtime-smoke-app-a", "status: missing previous release id");
  assertIncludes(statusResult.stdout, "- currentArtifactRef: docker://runtime-smoke-app:release-b", "status: missing current artifact ref");
  assertIncludes(statusResult.stdout, "- rollbackTarget.releaseId: release-runtime-smoke-app-a", "status: missing rollback release id");
  assertIncludes(statusResult.stdout, "- rollbackTarget.artifactRef: docker://runtime-smoke-app:release-a", "status: missing rollback artifact ref");
  assertIncludes(statusResult.stdout, "- rollbackTarget.strategy: restore", "status: missing rollback strategy");
  assertIncludes(statusResult.stdout, "- rollbackReady: yes", "status: missing rollback readiness");
  assertIncludes(statusResult.stdout, "- rollbackConfidence: ready", "status: missing healthy rollback confidence");
  assertIncludes(
    statusResult.stdout,
    "- receiptContractVersion: atlas.lifeline.release-receipt.v1",
    "status: missing receipt contract version",
  );
  assertIncludes(statusResult.stdout, "- receiptHealth: ok", "status: missing healthy receipt summary");
  assertIncludes(statusResult.stdout, "- releaseReplay: verified (6 receipts applied)", "status: missing release replay verification");
  assertIncludes(
    statusResult.stdout,
    "- latestReceipt: ",
    "status: missing latest receipt summary",
  );
  assertIncludes(statusResult.stdout, "- latestRollbackReceipt: rollback succeeded release-runtime-smoke-app-a", "status: missing rollback rehearsal receipt");
  assertIncludes(statusResult.stdout, "- receiptsDir: .lifeline/releases/runtime-smoke-app/receipts", "status: missing receipts dir");
  assertIncludes(statusResult.stdout, "- receipt: activate succeeded release-runtime-smoke-app-b", "status: missing receipt summary");

  const proofResult = await runCli(["status", appName, "--proof-text"], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    proofResult.code,
    0,
    `proof-text: expected exit 0, got ${proofResult.code}\n${proofResult.stdout}\n${proofResult.stderr}`,
  );
  assertIncludes(proofResult.stdout, "- currentReleaseId: release-runtime-smoke-app-b", "proof-text: missing current release id");
  assertIncludes(proofResult.stdout, "- previousReleaseId: release-runtime-smoke-app-a", "proof-text: missing previous release id");
  assertIncludes(proofResult.stdout, "- rollbackTarget: release-runtime-smoke-app-a (restore)", "proof-text: missing rollback target");
  assertIncludes(proofResult.stdout, "- rollbackReady: yes", "proof-text: missing rollback readiness");
  assertIncludes(proofResult.stdout, "- rollbackConfidence: ready", "proof-text: missing healthy rollback confidence");
  assertIncludes(
    proofResult.stdout,
    "- receiptContractVersion: atlas.lifeline.release-receipt.v1",
    "proof-text: missing receipt contract version",
  );
  assertIncludes(proofResult.stdout, "- receiptHealth: ok", "proof-text: missing healthy receipt summary");
  assertIncludes(proofResult.stdout, "- releaseReplay: verified (6 receipts applied)", "proof-text: missing release replay verification");
  assertIncludes(
    proofResult.stdout,
    "- latestReceipt: ",
    "proof-text: missing latest receipt summary",
  );
  assertIncludes(proofResult.stdout, "- latestRollbackReceipt: rollback succeeded release-runtime-smoke-app-a", "proof-text: missing rollback rehearsal receipt");

  const currentMetadataPath = path.join(
    tempWorkspace,
    ".lifeline",
    "releases",
    appName,
    releaseB.releaseId,
    "metadata.json",
  );
  const currentMetadata = JSON.parse(await readFile(currentMetadataPath, "utf8"));

  currentMetadata.rollbackTarget.releaseId = "stale-release";
  await writeFile(
    currentMetadataPath,
    `${JSON.stringify(currentMetadata, null, 2)}\n`,
    "utf8",
  );

  const driftedStatusResult = await runCli(["status", appName], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    driftedStatusResult.code,
    0,
    `drifted status: expected exit 0, got ${driftedStatusResult.code}\n${driftedStatusResult.stdout}\n${driftedStatusResult.stderr}`,
  );
  assertIncludes(driftedStatusResult.stdout, "- rollbackReady: no", "status: missing degraded rollback readiness");
  assertIncludes(driftedStatusResult.stdout, "- rollbackConfidence: degraded", "status: missing degraded rollback confidence");
  assertIncludes(
    driftedStatusResult.stdout,
    "rollback target releaseId stale-release does not match replayed previous release release-runtime-smoke-app-a",
    "status: missing rollback release drift detail",
  );

  const driftedProofResult = await runCli(["status", appName, "--proof-text"], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    driftedProofResult.code,
    0,
    `drifted proof-text: expected exit 0, got ${driftedProofResult.code}\n${driftedProofResult.stdout}\n${driftedProofResult.stderr}`,
  );
  assertIncludes(driftedProofResult.stdout, "- rollbackReady: no", "proof-text: missing degraded rollback readiness");
  assertIncludes(driftedProofResult.stdout, "- rollbackConfidence: degraded", "proof-text: missing degraded rollback confidence");
  assertIncludes(
    driftedProofResult.stdout,
    "rollback target releaseId stale-release does not match replayed previous release release-runtime-smoke-app-a",
    "proof-text: missing rollback release drift detail",
  );

  const driftedLogsResult = await runCli(["logs", appName, "20"], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    driftedLogsResult.code,
    0,
    `drifted logs: expected exit 0, got ${driftedLogsResult.code}\n${driftedLogsResult.stdout}\n${driftedLogsResult.stderr}`,
  );
  assertIncludes(driftedLogsResult.stdout, "- rollbackReady: no", "logs: missing degraded rollback readiness");
  assertIncludes(driftedLogsResult.stdout, "- rollbackConfidence: degraded", "logs: missing degraded rollback confidence");
  assertIncludes(
    driftedLogsResult.stdout,
    "rollback target releaseId stale-release does not match replayed previous release release-runtime-smoke-app-a",
    "logs: missing rollback release drift detail",
  );

  currentMetadata.rollbackTarget.releaseId = releaseA.releaseId;
  currentMetadata.rollbackTarget.artifactRef = "docker://runtime-smoke-app:stale-artifact";
  await writeFile(
    currentMetadataPath,
    `${JSON.stringify(currentMetadata, null, 2)}\n`,
    "utf8",
  );

  const staleArtifactStatusResult = await runCli(["status", appName], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    staleArtifactStatusResult.code,
    0,
    `stale artifact status: expected exit 0, got ${staleArtifactStatusResult.code}\n${staleArtifactStatusResult.stdout}\n${staleArtifactStatusResult.stderr}`,
  );
  assertIncludes(staleArtifactStatusResult.stdout, "- rollbackConfidence: degraded", "status: missing stale artifact rollback confidence");
  assertIncludes(
    staleArtifactStatusResult.stdout,
    "rollback target artifactRef docker://runtime-smoke-app:stale-artifact does not match replayed previous artifact docker://runtime-smoke-app:release-a",
    "status: missing stale artifact rollback detail",
  );

  currentMetadata.rollbackTarget.artifactRef = releaseA.releaseMetadata.artifactRef;
  await writeFile(
    currentMetadataPath,
    `${JSON.stringify(currentMetadata, null, 2)}\n`,
    "utf8",
  );

  const receiptsDir = path.join(
    tempWorkspace,
    ".lifeline",
    "releases",
    appName,
    "receipts",
  );
  await writeFile(
    path.join(receiptsDir, "mismatched-receipt.json"),
    JSON.stringify({
      contractVersion: "atlas.lifeline.release-receipt.v0",
      receiptId: "mismatched-receipt",
      action: "activate",
      status: "succeeded",
      releaseId: "release-runtime-smoke-app-z",
      createdAt: "2026-04-26T00:06:00.000Z",
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(receiptsDir, "unreadable-receipt.json"),
    "{not-json",
    "utf8",
  );

  const degradedStatusResult = await runCli(["status", appName], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    degradedStatusResult.code,
    0,
    `degraded status: expected exit 0, got ${degradedStatusResult.code}\n${degradedStatusResult.stdout}\n${degradedStatusResult.stderr}`,
  );
  assertIncludes(
    degradedStatusResult.stdout,
    "- rollbackConfidence: degraded",
    "status: missing replay-driven degraded rollback confidence",
  );
  assertIncludes(
    degradedStatusResult.stdout,
    "- receiptHealth: degraded (versionMismatch=1, unreadable=1)",
    "status: missing degraded receipt health summary",
  );
  assertIncludes(
    degradedStatusResult.stdout,
    "- releaseReplay: degraded (6 receipts applied)",
    "status: missing degraded release replay state",
  );
  assertIncludes(
    degradedStatusResult.stdout,
    "unsupported contractVersion atlas.lifeline.release-receipt.v0",
    "status: missing release replay issue for wrong-version receipt",
  );

  const tamperedCurrentPointerPath = path.join(
    tempWorkspace,
    ".lifeline",
    "releases",
    appName,
    "current.json",
  );
  const tamperedCurrent = JSON.parse(await readFile(tamperedCurrentPointerPath, "utf8"));
  tamperedCurrent.releaseId = "tampered-release";
  await writeFile(
    tamperedCurrentPointerPath,
    `${JSON.stringify(tamperedCurrent, null, 2)}\n`,
    "utf8",
  );

  const degradedProofResult = await runCli(["status", appName, "--proof-text"], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    degradedProofResult.code,
    0,
    `degraded proof-text: expected exit 0, got ${degradedProofResult.code}\n${degradedProofResult.stdout}\n${degradedProofResult.stderr}`,
  );
  assertIncludes(
    degradedProofResult.stdout,
    "- rollbackConfidence: degraded",
    "proof-text: missing replay-driven degraded rollback confidence",
  );
  assertIncludes(
    degradedProofResult.stdout,
    "- receiptHealth: degraded (versionMismatch=1, unreadable=1)",
    "proof-text: missing degraded receipt health summary",
  );
  assertIncludes(degradedProofResult.stdout, "- releaseReplay: degraded (6 receipts applied)", "proof-text: missing degraded release replay state");
  assertIncludes(
    degradedProofResult.stdout,
    "current pointer mismatch: persisted=tampered-release replayed=release-runtime-smoke-app-b",
    "proof-text: missing degraded replay issue detail",
  );
  tamperedCurrent.releaseId = releaseB.releaseId;
  await writeFile(
    tamperedCurrentPointerPath,
    `${JSON.stringify(tamperedCurrent, null, 2)}\n`,
    "utf8",
  );

  const logsResult = await runCli(["logs", appName, "20"], {
    cwd: tempWorkspace,
    allowFailure: true,
  });
  assert.equal(
    logsResult.code,
    0,
    `logs: expected exit 0, got ${logsResult.code}\n${logsResult.stdout}\n${logsResult.stderr}`,
  );
  assertIncludes(logsResult.stdout, `=== lifeline logs ${appName} ===`, "logs: missing evidence header");
  assertIncludes(logsResult.stdout, "- currentReleaseId: release-runtime-smoke-app-b", "logs: missing current release id");
  assertIncludes(logsResult.stdout, "- previousReleaseId: release-runtime-smoke-app-a", "logs: missing previous release id");
  assertIncludes(logsResult.stdout, "- rollbackConfidence: degraded", "logs: missing degraded rollback confidence");
  assertIncludes(
    logsResult.stdout,
    "- receiptContractVersion: atlas.lifeline.release-receipt.v1",
    "logs: missing receipt contract version",
  );
  assertIncludes(
    logsResult.stdout,
    "- latestReceipt: ",
    "logs: missing latest receipt summary",
  );
  assertIncludes(
    logsResult.stdout,
    "- receiptHealth: degraded (versionMismatch=1, unreadable=1)",
    "logs: missing degraded receipt health summary",
  );
  assertIncludes(logsResult.stdout, "=== lifeline up ", "logs: missing startup header");
  assertIncludes(logsResult.stdout, `runtime-smoke-app listening on ${port}`, "logs: missing app startup line");

  const noPreviousWorkspace = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-release-no-previous-workspace-"),
  );
  const noPreviousPort = await getFreePort();
  const { tempRoot: noPreviousFixtureRoot, manifestPath: noPreviousManifestPath } =
    await createDisposableFixtureRoot(noPreviousPort);

  try {
    const upNoPrevious = await runCli(["up", noPreviousManifestPath], {
      cwd: noPreviousWorkspace,
      allowFailure: true,
    });
    assert.equal(
      upNoPrevious.code,
      0,
      `no-previous up: expected exit 0, got ${upNoPrevious.code}\n${upNoPrevious.stdout}\n${upNoPrevious.stderr}`,
    );

    const noPreviousRelease = await persistWave1Release(
      createReleaseManifest({
        artifactRef: "docker://runtime-smoke-app:no-previous",
        rollbackReleaseId: "bootstrap-release",
        rollbackArtifactRef: "docker://runtime-smoke-app:bootstrap",
        port: noPreviousPort,
      }),
      {
        rootDir: noPreviousWorkspace,
        releaseId: "release-runtime-smoke-app-only",
        createdAt: "2026-04-26T01:00:00.000Z",
        receiptAt: "2026-04-26T01:00:00.000Z",
      },
    );
    await activateWave1Release(noPreviousWorkspace, appName, noPreviousRelease.releaseId, {
      receiptAt: "2026-04-26T01:01:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    });

    const noPreviousStatus = await runCli(["status", appName], {
      cwd: noPreviousWorkspace,
      allowFailure: true,
    });
    assert.equal(
      noPreviousStatus.code,
      0,
      `no-previous status: expected exit 0, got ${noPreviousStatus.code}\n${noPreviousStatus.stdout}\n${noPreviousStatus.stderr}`,
    );
    assertIncludes(noPreviousStatus.stdout, "- rollbackReady: no", "status: missing no-previous rollback readiness");
    assertIncludes(noPreviousStatus.stdout, "- rollbackConfidence: degraded", "status: missing no-previous rollback confidence");
    assertIncludes(
      noPreviousStatus.stdout,
      "replayed previous-release evidence is missing",
      "status: missing no-previous evidence detail",
    );
  } finally {
    await runCli(["down", appName], { cwd: noPreviousWorkspace, allowFailure: true }).catch(() => undefined);
    await removeTreeWithRetries(noPreviousWorkspace);
    await removeTreeWithRetries(noPreviousFixtureRoot);
  }

  cleanupNeeded = false;
  console.log("Wave 1 operator evidence deterministic verification passed.");
} finally {
  if (cleanupNeeded) {
    await runCli(["down", appName], { cwd: tempWorkspace, allowFailure: true }).catch(() => undefined);
  }

  await runCli(["down", appName], { cwd: tempWorkspace, allowFailure: true }).catch(() => undefined);
  await removeTreeWithRetries(tempWorkspace);
  await removeTreeWithRetries(fixtureRoot);
}
