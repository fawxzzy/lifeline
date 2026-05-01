import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { persistWave1Release, activateWave1Release } from "../control-plane/wave1-release-engine.mjs";
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
  assertIncludes(logsResult.stdout, "=== lifeline up ", "logs: missing startup header");
  assertIncludes(logsResult.stdout, `runtime-smoke-app listening on ${port}`, "logs: missing app startup line");

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
