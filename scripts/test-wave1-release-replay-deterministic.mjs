import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ensureBuilt } from "./lib/ensure-built.mjs";
import {
  activateWave1Release,
  persistWave1Release,
  rollbackWave1Release,
} from "../control-plane/wave1-release-engine.mjs";

function createManifest({
  appName,
  artifactRef,
  rollbackReleaseId,
  rollbackArtifactRef,
  migrationHooks,
}) {
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
      ...(migrationHooks ?? {}),
    },
    rollbackTarget: {
      releaseId: rollbackReleaseId,
      artifactRef: rollbackArtifactRef,
      strategy: "restore",
    },
  };
}

function quoteShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildHookCommand(scriptPath, phase, mode, logPath) {
  return [process.execPath, scriptPath, phase, mode, logPath]
    .map(quoteShellArg)
    .join(" ");
}

async function writeHookRunner(scriptPath) {
  await writeFile(
    scriptPath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "const [phase, mode, logPath] = process.argv.slice(2);",
      "await appendFile(logPath, `${phase}\\n`, 'utf8');",
      "if (mode === 'fail') {",
      "  process.exit(1);",
      "}",
    ].join("\n"),
    "utf8",
  );
}

await ensureBuilt();
const { replayWave1ReleaseReceipts, verifyWave1ReleaseReplay } = await import(
  "../dist/core/release-replay.js"
);

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-release-replay-"),
);

try {
  const appName = "lifeline-pilot";
  const hookRunnerPath = path.join(tempRoot, "hook-runner.mjs");
  const hookLogPath = path.join(tempRoot, "hook-log.txt");
  await writeHookRunner(hookRunnerPath);

  const successHooks = {
    preActivate: [
      buildHookCommand(hookRunnerPath, "preActivate", "success", hookLogPath),
    ],
    postActivate: [
      buildHookCommand(hookRunnerPath, "postActivate", "success", hookLogPath),
    ],
    preRollback: [
      buildHookCommand(hookRunnerPath, "preRollback", "success", hookLogPath),
    ],
  };
  const failingPreActivateHooks = {
    ...successHooks,
    preActivate: [
      buildHookCommand(hookRunnerPath, "preActivate", "fail", hookLogPath),
    ],
  };
  const failingPreRollbackHooks = {
    ...successHooks,
    preRollback: [
      buildHookCommand(hookRunnerPath, "preRollback", "fail", hookLogPath),
    ],
  };

  const releaseA = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rollbackReleaseId: "bootstrap-release",
      rollbackArtifactRef:
        "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      migrationHooks: successHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260511-0001",
      createdAt: "2026-05-11T14:00:00.000Z",
      receiptAt: "2026-05-11T14:00:00.000Z",
    },
  );

  await activateWave1Release(tempRoot, appName, releaseA.releaseId, {
    receiptAt: "2026-05-11T14:05:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  let verification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(verification.ok, true, verification.issues.join("\n"));
  assert.equal(verification.replayedCurrent?.releaseId, releaseA.releaseId);
  assert.equal(verification.replayedPrevious, undefined);

  const releaseB = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      rollbackReleaseId: releaseA.releaseId,
      rollbackArtifactRef: releaseA.releaseMetadata.artifactRef,
      migrationHooks: successHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260511-0002",
      createdAt: "2026-05-11T14:10:00.000Z",
      receiptAt: "2026-05-11T14:10:00.000Z",
    },
  );

  await activateWave1Release(tempRoot, appName, releaseB.releaseId, {
    receiptAt: "2026-05-11T14:15:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  verification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(verification.ok, true, verification.issues.join("\n"));
  assert.equal(verification.replayedCurrent?.releaseId, releaseB.releaseId);
  assert.equal(verification.replayedPrevious?.releaseId, releaseA.releaseId);

  const releaseC = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      rollbackReleaseId: releaseB.releaseId,
      rollbackArtifactRef: releaseB.releaseMetadata.artifactRef,
      migrationHooks: failingPreActivateHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260511-0003",
      createdAt: "2026-05-11T14:20:00.000Z",
      receiptAt: "2026-05-11T14:20:00.000Z",
    },
  );

  await activateWave1Release(tempRoot, appName, releaseC.releaseId, {
    receiptAt: "2026-05-11T14:25:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  verification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(verification.ok, true, verification.issues.join("\n"));
  assert.equal(verification.replayedCurrent?.releaseId, releaseB.releaseId);
  assert.equal(verification.replayedPrevious?.releaseId, releaseA.releaseId);

  await rollbackWave1Release(tempRoot, appName, {
    receiptAt: "2026-05-11T14:30:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  verification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(verification.ok, true, verification.issues.join("\n"));
  assert.equal(verification.replayedCurrent?.releaseId, releaseA.releaseId);
  assert.equal(verification.replayedPrevious?.releaseId, releaseB.releaseId);

  const releaseD = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      rollbackReleaseId: releaseA.releaseId,
      rollbackArtifactRef: releaseA.releaseMetadata.artifactRef,
      migrationHooks: failingPreRollbackHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260511-0004",
      createdAt: "2026-05-11T14:35:00.000Z",
      receiptAt: "2026-05-11T14:35:00.000Z",
    },
  );

  await activateWave1Release(tempRoot, appName, releaseD.releaseId, {
    receiptAt: "2026-05-11T14:40:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  await rollbackWave1Release(tempRoot, appName, {
    receiptAt: "2026-05-11T14:45:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });

  verification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(verification.ok, true, verification.issues.join("\n"));
  assert.equal(verification.replayedCurrent?.releaseId, releaseA.releaseId);
  assert.equal(verification.replayedPrevious?.releaseId, releaseD.releaseId);
  assert.equal(verification.appliedReceipts.length, 10);

  const currentPointerPath = path.join(
    tempRoot,
    ".lifeline",
    "releases",
    appName,
    "current.json",
  );
  const persistedCurrent = JSON.parse(await readFile(currentPointerPath, "utf8"));
  persistedCurrent.releaseId = "tampered-release";
  await writeFile(currentPointerPath, `${JSON.stringify(persistedCurrent, null, 2)}\n`, "utf8");

  const replayOnly = await replayWave1ReleaseReceipts(appName, tempRoot);
  assert.equal(replayOnly.replayedCurrent?.releaseId, releaseA.releaseId);
  assert.equal(replayOnly.replayedPrevious?.releaseId, releaseD.releaseId);
  assert.deepEqual(replayOnly.issues, []);

  const receiptsDir = path.join(
    tempRoot,
    ".lifeline",
    "releases",
    appName,
    "receipts",
  );
  const malformedReceiptPath = path.join(receiptsDir, "malformed.json");
  await writeFile(malformedReceiptPath, "{not-json}\n", "utf8");

  const malformedReplay = await replayWave1ReleaseReceipts(appName, tempRoot);
  assert.equal(malformedReplay.replayedCurrent?.releaseId, releaseA.releaseId);
  assert.equal(malformedReplay.replayedPrevious?.releaseId, releaseD.releaseId);
  assert.match(
    malformedReplay.issues.join("\n"),
    /malformed\.json is not valid JSON/,
  );
  await rm(malformedReceiptPath, { force: true });

  const wrongVersionReceiptPath = path.join(receiptsDir, "wrong-version.json");
  await writeFile(
    wrongVersionReceiptPath,
    `${JSON.stringify(
      {
        contractVersion: "atlas.lifeline.release-receipt.v0",
        receiptId: "wrong-version-receipt",
        action: "activate",
        status: "succeeded",
        releaseId: releaseD.releaseId,
        previousReleaseId: releaseA.releaseId,
        createdAt: "2026-05-11T14:50:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const wrongVersionReplay = await replayWave1ReleaseReceipts(appName, tempRoot);
  assert.match(
    wrongVersionReplay.issues.join("\n"),
    /wrong-version\.json has unsupported contractVersion atlas\.lifeline\.release-receipt\.v0/,
  );
  await rm(wrongVersionReceiptPath, { force: true });

  const duplicateReceiptPath = path.join(receiptsDir, "duplicate-id.json");
  await writeFile(
    duplicateReceiptPath,
    `${JSON.stringify(
      {
        contractVersion: "atlas.lifeline.release-receipt.v1",
        receiptId: releaseD.receipt.receiptId,
        action: "activate",
        status: "succeeded",
        releaseId: releaseD.releaseId,
        previousReleaseId: releaseA.releaseId,
        createdAt: "2026-05-11T14:55:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const duplicateReplay = await replayWave1ReleaseReceipts(appName, tempRoot);
  assert.match(
    duplicateReplay.issues.join("\n"),
    /duplicate release receipt id .*duplicate-id\.json/,
  );
  await rm(duplicateReceiptPath, { force: true });

  const tamperedVerification = await verifyWave1ReleaseReplay(appName, tempRoot);
  assert.equal(tamperedVerification.ok, false);
  assert.match(
    tamperedVerification.issues.join("\n"),
    /current pointer mismatch: persisted=tampered-release replayed=release-20260511-0001/,
  );

  console.log("Wave 1 release replay deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
