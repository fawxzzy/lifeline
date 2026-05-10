import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  buildWave1ReleaseMetadata,
  serializeWave1ReleaseMetadata,
} from "../control-plane/wave1-deploy-contract.mjs";
import {
  activateWave1Release,
  persistWave1Release,
  readWave1ReleaseState,
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

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildHookCommand(scriptPath, phase, mode, logPath) {
  return [
    process.execPath,
    scriptPath,
    phase,
    mode,
    logPath,
  ]
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

async function readHookLogLines(logPath) {
  const contents = await readFile(logPath, "utf8");
  return contents
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

async function writeLegacyReleaseMetadata(rootDir, manifest, options) {
  const builtMetadata = buildWave1ReleaseMetadata(manifest, options);
  assert.equal(
    builtMetadata.issues.length,
    0,
    `unexpected legacy metadata build issues: ${JSON.stringify(builtMetadata.issues)}`,
  );

  const legacyMetadata = {
    ...builtMetadata.metadata,
  };
  delete legacyMetadata.releaseTarget;

  const releaseDir = path.join(
    rootDir,
    ".lifeline",
    "releases",
    legacyMetadata.appName,
    legacyMetadata.releaseId,
  );
  await mkdir(releaseDir, { recursive: true });
  await writeFile(
    path.join(releaseDir, "metadata.json"),
    `${serializeWave1ReleaseMetadata(legacyMetadata)}\n`,
    "utf8",
  );

  return legacyMetadata;
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-release-mechanics-"),
);

try {
  const appName = "lifeline-pilot";
  const outsidePath = path.join(tempRoot, ".lifeline", "outside");
  const escapedAppPath = path.join(tempRoot, ".lifeline", "escaped-app");
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
      releaseId: "release-20260425-0001",
      createdAt: "2026-04-25T18:00:00.000Z",
      receiptAt: "2026-04-25T18:00:00.000Z",
    },
  );
  assert.equal(releaseA.validation.status, "passed");
  assert.equal(releaseA.receipt.action, "planned");
  assert.equal(releaseA.receipt.releaseId, "release-20260425-0001");
  assert.equal(
    releaseA.receipt.releaseMetadataPath,
    ".lifeline/releases/lifeline-pilot/release-20260425-0001/metadata.json",
  );
  assert.equal(
    releaseA.receipt.releaseDirectory,
    ".lifeline/releases/lifeline-pilot/release-20260425-0001",
  );

  await assert.rejects(
    persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      rollbackReleaseId: "bootstrap-release",
      rollbackArtifactRef:
        "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      migrationHooks: successHooks,
    }),
      {
        rootDir: tempRoot,
        releaseId: "../../outside",
        createdAt: "2026-04-25T18:01:00.000Z",
        receiptAt: "2026-04-25T18:01:00.000Z",
      },
    ),
    /Invalid releaseId "\.\.\/\.\.\/outside": path separators are not allowed\./,
  );
  assert.equal(await pathExists(outsidePath), false);

  await assert.rejects(
    persistWave1Release(
      createManifest({
        appName: "../escaped-app",
        artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:1313131313131313131313131313131313131313131313131313131313131313",
        rollbackReleaseId: "bootstrap-release",
        rollbackArtifactRef:
          "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
        migrationHooks: successHooks,
      }),
      {
        rootDir: tempRoot,
        releaseId: "release-20260425-0001-appname-unix",
        createdAt: "2026-04-25T18:01:30.000Z",
        receiptAt: "2026-04-25T18:01:30.000Z",
      },
    ),
    /Invalid appName "\.\.\/escaped-app": path separators are not allowed\./,
  );
  assert.equal(await pathExists(escapedAppPath), false);

  await assert.rejects(
    persistWave1Release(
      createManifest({
        appName: "..\\escaped-app",
        artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:1414141414141414141414141414141414141414141414141414141414141414",
        rollbackReleaseId: "bootstrap-release",
        rollbackArtifactRef:
          "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
        migrationHooks: successHooks,
      }),
      {
        rootDir: tempRoot,
        releaseId: "release-20260425-0001-appname-win",
        createdAt: "2026-04-25T18:01:45.000Z",
        receiptAt: "2026-04-25T18:01:45.000Z",
      },
    ),
    /Invalid appName "\.\.\\escaped-app": path separators are not allowed\./,
  );
  assert.equal(await pathExists(escapedAppPath), false);

  await assert.rejects(
    persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:1212121212121212121212121212121212121212121212121212121212121212",
      rollbackReleaseId: "bootstrap-release",
      rollbackArtifactRef:
        "ghcr.io/fawxzzy/lifeline-pilot@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      migrationHooks: successHooks,
    }),
      {
        rootDir: tempRoot,
        releaseId: "..\\..\\outside",
        createdAt: "2026-04-25T18:02:00.000Z",
        receiptAt: "2026-04-25T18:02:00.000Z",
      },
    ),
    /Invalid releaseId "\.\.\\\.\.\\outside": path separators are not allowed\./,
  );
  assert.equal(await pathExists(outsidePath), false);

  const activationA = await activateWave1Release(
    tempRoot,
    appName,
    releaseA.releaseId,
    {
      receiptAt: "2026-04-25T18:05:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(activationA.ok, true);
  assert.equal(activationA.current.releaseId, releaseA.releaseId);
  assert.equal(activationA.previous, undefined);
  assert.equal(activationA.receipt.phaseEvidence.preActivate.status, "succeeded");
  assert.equal(activationA.receipt.phaseEvidence.postActivate.status, "succeeded");
  assert.deepEqual(await readHookLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
  ]);

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
      releaseId: "release-20260425-0002",
      createdAt: "2026-04-25T18:10:00.000Z",
      receiptAt: "2026-04-25T18:10:00.000Z",
    },
  );
  const activationB = await activateWave1Release(
    tempRoot,
    appName,
    releaseB.releaseId,
    {
      receiptAt: "2026-04-25T18:15:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(activationB.ok, true);
  assert.equal(activationB.current.releaseId, releaseB.releaseId);
  assert.equal(activationB.previous.releaseId, releaseA.releaseId);
  assert.equal(activationB.receipt.phaseEvidence.preActivate.status, "succeeded");
  assert.equal(activationB.receipt.phaseEvidence.postActivate.status, "succeeded");
  assert.equal(
    activationB.receipt.lineage.promotedFromReleaseId,
    releaseA.releaseId,
  );
  assert.equal(
    activationB.receipt.lineage.promotedToReleaseId,
    releaseB.releaseId,
  );
  assert.equal(activationB.receipt.health.status, 200);
  assert.deepEqual(await readHookLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
  ]);

  const stateAfterSuccess = await readWave1ReleaseState(tempRoot, appName);
  assert.equal(stateAfterSuccess.current.releaseId, releaseB.releaseId);
  assert.equal(stateAfterSuccess.previous.releaseId, releaseA.releaseId);

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
      releaseId: "release-20260425-0003",
      createdAt: "2026-04-25T18:20:00.000Z",
      receiptAt: "2026-04-25T18:20:00.000Z",
    },
  );
  const failedActivation = await activateWave1Release(
    tempRoot,
    appName,
    releaseC.releaseId,
    {
      receiptAt: "2026-04-25T18:25:00.000Z",
      checkHealth: async () => ({
        ok: false,
        status: 503,
        error: "health gate rejected candidate",
      }),
    },
  );
  assert.equal(failedActivation.ok, false);
  assert.equal(failedActivation.current.releaseId, releaseB.releaseId);
  assert.equal(failedActivation.previous.releaseId, releaseA.releaseId);
  assert.equal(failedActivation.receipt.status, "failed");
  assert.equal(failedActivation.receipt.failedPhase, "preActivate");
  assert.equal(failedActivation.receipt.phaseEvidence.preActivate.status, "failed");
  assert.equal(
    failedActivation.receipt.preservedCurrentReleaseId,
    releaseB.releaseId,
  );
  assert.deepEqual(await readHookLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preActivate",
  ]);

  const stateAfterFailedActivation = await readWave1ReleaseState(tempRoot, appName);
  assert.equal(stateAfterFailedActivation.current.releaseId, releaseB.releaseId);
  assert.equal(stateAfterFailedActivation.previous.releaseId, releaseA.releaseId);

  const rollbackResult = await rollbackWave1Release(tempRoot, appName, {
    receiptAt: "2026-04-25T18:30:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(rollbackResult.ok, true);
  assert.equal(rollbackResult.current.releaseId, releaseA.releaseId);
  assert.equal(rollbackResult.previous.releaseId, releaseB.releaseId);
  assert.equal(rollbackResult.receipt.action, "rollback");
  assert.equal(rollbackResult.receipt.status, "succeeded");
  assert.equal(rollbackResult.receipt.previousReleaseId, releaseB.releaseId);
  assert.equal(rollbackResult.receipt.phaseEvidence.preRollback.status, "succeeded");
  assert.deepEqual(await readHookLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preActivate",
    "preRollback",
  ]);

  const finalState = await readWave1ReleaseState(tempRoot, appName);
  assert.equal(finalState.current.releaseId, releaseA.releaseId);
  assert.equal(finalState.previous.releaseId, releaseB.releaseId);

  const activationReceipt = await readJson(
    tempRoot,
    activationB.receipt.receiptPath,
  );
  assert.equal(activationReceipt.releaseId, releaseB.releaseId);
  assert.equal(activationReceipt.action, "activate");
  assert.equal(
    activationReceipt.releaseMetadataPath,
    ".lifeline/releases/lifeline-pilot/release-20260425-0002/metadata.json",
  );

  const rollbackReceipt = await readJson(
    tempRoot,
    rollbackResult.receipt.receiptPath,
  );
  assert.equal(rollbackReceipt.releaseId, releaseA.releaseId);
  assert.equal(rollbackReceipt.previousReleaseId, releaseB.releaseId);
  assert.equal(rollbackReceipt.health.status, 200);

  const legacyReleaseId = "release-20260425-legacy";
  const legacyArtifactRef =
    "ghcr.io/fawxzzy/lifeline-pilot@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const legacyMetadata = await writeLegacyReleaseMetadata(
    tempRoot,
    createManifest({
      appName,
      artifactRef: legacyArtifactRef,
      rollbackReleaseId: releaseA.releaseId,
      rollbackArtifactRef: releaseA.releaseMetadata.artifactRef,
      migrationHooks: successHooks,
    }),
    {
      releaseId: legacyReleaseId,
      createdAt: "2026-04-25T18:35:00.000Z",
      dryRun: false,
    },
  );
  const legacyActivation = await activateWave1Release(
    tempRoot,
    appName,
    legacyReleaseId,
    {
      receiptAt: "2026-04-25T18:35:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(legacyActivation.ok, true);
  assert.equal(legacyActivation.current.releaseId, legacyReleaseId);
  assert.equal(legacyActivation.previous.releaseId, releaseA.releaseId);
  assert.deepEqual(legacyActivation.receipt.releaseTarget, {
    kind: "single-host-immutable",
    releaseId: legacyReleaseId,
    artifactRef: legacyArtifactRef,
  });

  const releaseD = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      rollbackReleaseId: legacyReleaseId,
      rollbackArtifactRef: legacyArtifactRef,
      migrationHooks: successHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260425-0004",
      createdAt: "2026-04-25T18:40:00.000Z",
      receiptAt: "2026-04-25T18:40:00.000Z",
    },
  );
  const activationD = await activateWave1Release(
    tempRoot,
    appName,
    releaseD.releaseId,
    {
      receiptAt: "2026-04-25T18:45:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(activationD.ok, true);
  assert.equal(activationD.previous.releaseId, legacyReleaseId);

  const legacyRollback = await rollbackWave1Release(tempRoot, appName, {
    receiptAt: "2026-04-25T18:50:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(legacyRollback.ok, true);
  assert.equal(legacyRollback.current.releaseId, legacyReleaseId);
  assert.equal(legacyRollback.previous.releaseId, releaseD.releaseId);
  assert.deepEqual(legacyRollback.receipt.releaseTarget, {
    kind: "single-host-immutable",
    releaseId: legacyMetadata.releaseId,
    artifactRef: legacyMetadata.artifactRef,
  });

  const rollbackBlockerRelease = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      rollbackReleaseId: legacyReleaseId,
      rollbackArtifactRef: legacyArtifactRef,
      migrationHooks: failingPreRollbackHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260425-0005",
      createdAt: "2026-04-25T18:55:00.000Z",
      receiptAt: "2026-04-25T18:55:00.000Z",
    },
  );
  const rollbackBlockerActivation = await activateWave1Release(
    tempRoot,
    appName,
    rollbackBlockerRelease.releaseId,
    {
      receiptAt: "2026-04-25T18:56:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(rollbackBlockerActivation.ok, true);
  assert.equal(rollbackBlockerActivation.current.releaseId, rollbackBlockerRelease.releaseId);
  assert.equal(rollbackBlockerActivation.previous.releaseId, legacyReleaseId);

  const rollbackTargetRelease = await persistWave1Release(
    createManifest({
      appName,
      artifactRef: "ghcr.io/fawxzzy/lifeline-pilot@sha256:abababababababababababababababababababababababababababababababab",
      rollbackReleaseId: rollbackBlockerRelease.releaseId,
      rollbackArtifactRef: rollbackBlockerRelease.releaseMetadata.artifactRef,
      migrationHooks: successHooks,
    }),
    {
      rootDir: tempRoot,
      releaseId: "release-20260425-0006",
      createdAt: "2026-04-25T18:57:00.000Z",
      receiptAt: "2026-04-25T18:57:00.000Z",
    },
  );
  const rollbackTargetActivation = await activateWave1Release(
    tempRoot,
    appName,
    rollbackTargetRelease.releaseId,
    {
      receiptAt: "2026-04-25T18:58:00.000Z",
      checkHealth: async () => ({ ok: true, status: 200 }),
    },
  );
  assert.equal(rollbackTargetActivation.ok, true);
  assert.equal(rollbackTargetActivation.current.releaseId, rollbackTargetRelease.releaseId);
  assert.equal(rollbackTargetActivation.previous.releaseId, rollbackBlockerRelease.releaseId);

  const blockedRollback = await rollbackWave1Release(tempRoot, appName, {
    receiptAt: "2026-04-25T18:59:00.000Z",
    checkHealth: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(blockedRollback.ok, false);
  assert.equal(blockedRollback.current.releaseId, rollbackTargetRelease.releaseId);
  assert.equal(blockedRollback.previous.releaseId, rollbackBlockerRelease.releaseId);
  assert.equal(blockedRollback.receipt.failedPhase, "preRollback");
  assert.equal(blockedRollback.receipt.phaseEvidence.preRollback.status, "failed");
  assert.equal(
    blockedRollback.receipt.preservedCurrentReleaseId,
    rollbackTargetRelease.releaseId,
  );
  assert.equal(
    blockedRollback.receipt.preservedPreviousReleaseId,
    rollbackBlockerRelease.releaseId,
  );
  assert.deepEqual(await readHookLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preActivate",
    "preRollback",
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preRollback",
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preRollback",
  ]);

  console.log("Wave 1 release mechanics deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
