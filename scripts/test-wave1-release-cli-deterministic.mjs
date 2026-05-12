import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ensureBuilt } from "./lib/ensure-built.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "dist", "cli.js");
const fixtureManifestPath = path.join(
  repoRoot,
  "control-plane",
  "fixtures",
  "wave1-pilot-deploy.manifest.json",
);

function parseJsonOutput(output) {
  return JSON.parse(output);
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

async function readLogLines(filePath) {
  const contents = await readFile(filePath, "utf8");
  return contents
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

async function runCli(cwd, args, envOverrides = undefined) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(envOverrides ?? {}),
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const exitError = /** @type {{ code?: number; stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof exitError.code === "number" ? exitError.code : 1,
      stdout: exitError.stdout ?? "",
      stderr: exitError.stderr ?? "",
    };
  }
}

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-release-cli-"));

try {
  const hookLogPath = path.join(tempRoot, "hook-log.txt");
  const hookRunnerPath = path.join(tempRoot, "hook-runner.mjs");
  await writeFile(
    hookRunnerPath,
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

  const manifestSource = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
  manifestSource.migrationHooks = {
    ...manifestSource.migrationHooks,
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
  const hookedManifestPath = path.join(tempRoot, "wave1-pilot-release.manifest.json");
  await writeFile(
    hookedManifestPath,
    `${JSON.stringify(manifestSource, null, 2)}\n`,
    "utf8",
  );

  const missingAction = await runCli(tempRoot, ["release"]);
  assert.equal(missingAction.code, 1);
  assert.match(
    missingAction.stderr,
    /Missing release action\. Use one of: plan, persist, activate, rollback\./,
  );

  const missingManifest = await runCli(tempRoot, ["release", "plan"]);
  assert.equal(missingManifest.code, 1);
  assert.match(missingManifest.stderr, /Missing deploy manifest path\./);

  const planResult = await runCli(tempRoot, [
    "release",
    "plan",
    hookedManifestPath,
  ]);
  assert.equal(planResult.code, 0, planResult.stderr);
  const planned = parseJsonOutput(planResult.stdout);
  assert.equal(planned.validation.status, "passed");
  assert.equal(planned.appName, "lifeline-pilot");
  assert.equal(planned.releaseMetadata.releaseTarget.kind, "single-host-immutable");
  assert.equal(planned.rootDir.replace(/\\/g, "/"), tempRoot.replace(/\\/g, "/"));

  const persistedResult = await runCli(tempRoot, [
    "release",
    "persist",
    hookedManifestPath,
  ]);
  assert.equal(persistedResult.code, 0, persistedResult.stderr);
  const persisted = parseJsonOutput(persistedResult.stdout);
  assert.equal(persisted.validation.status, "passed");
  assert.equal(persisted.receipt.action, "planned");
  assert.equal(persisted.receipt.status, "planned");

  const firstReleaseId = persisted.releaseId;
  const firstMetadataPath = path.join(
    tempRoot,
    ".lifeline",
    "releases",
    "lifeline-pilot",
    firstReleaseId,
    "metadata.json",
  );
  const firstMetadata = JSON.parse(await readFile(firstMetadataPath, "utf8"));
  assert.equal(firstMetadata.releaseId, firstReleaseId);

  const unconfirmedActivateResult = await runCli(
    tempRoot,
    [
      "release",
      "activate",
      "lifeline-pilot",
      firstReleaseId,
    ],
    {
      LIFELINE_RELEASE_CONFIRMATION_CONTEXT: "interactive",
    },
  );
  assert.equal(unconfirmedActivateResult.code, 1);
  assert.match(
    unconfirmedActivateResult.stderr,
    new RegExp(
      `Re-run with:\\s+lifeline release activate lifeline-pilot ${firstReleaseId} --yes`,
    ),
  );

  const activateFirstResult = await runCli(tempRoot, [
    "release",
    "activate",
    "lifeline-pilot",
    firstReleaseId,
    "--confirm",
  ]);
  assert.equal(activateFirstResult.code, 0, activateFirstResult.stderr);
  const activatedFirst = parseJsonOutput(activateFirstResult.stdout);
  assert.equal(activatedFirst.ok, true);
  assert.equal(activatedFirst.current.releaseId, firstReleaseId);
  assert.equal(activatedFirst.receipt.action, "activate");
  assert.equal(activatedFirst.receipt.status, "succeeded");
  assert.equal(activatedFirst.receipt.phaseEvidence.preActivate.status, "succeeded");
  assert.equal(activatedFirst.receipt.phaseEvidence.postActivate.status, "succeeded");
  assert.deepEqual(await readLogLines(hookLogPath), ["preActivate", "postActivate"]);

  const secondManifestPath = path.join(tempRoot, "wave1-pilot-deploy-2.manifest.json");
  const secondManifest = JSON.parse(await readFile(hookedManifestPath, "utf8"));
  secondManifest.imageRef =
    "ghcr.io/fawxzzy/lifeline-pilot@sha256:22223333444455556666777788889999aaaabbbbccccddddeeeeffff00001111";
  secondManifest.rollbackTarget.releaseId = firstReleaseId;
  secondManifest.rollbackTarget.artifactRef = firstMetadata.artifactRef;
  secondManifest.rollbackTarget.strategy = "restore";
  await writeFile(secondManifestPath, JSON.stringify(secondManifest, null, 2), "utf8");

  const persistSecondResult = await runCli(tempRoot, [
    "release",
    "persist",
    secondManifestPath,
  ]);
  assert.equal(persistSecondResult.code, 0, persistSecondResult.stderr);
  const persistedSecond = parseJsonOutput(persistSecondResult.stdout);
  assert.equal(persistedSecond.receipt.action, "planned");
  const secondReleaseId = persistedSecond.releaseId;

  const activateSecondResult = await runCli(tempRoot, [
    "release",
    "activate",
    "lifeline-pilot",
    secondReleaseId,
    "--yes",
  ]);
  assert.equal(activateSecondResult.code, 0, activateSecondResult.stderr);
  const activatedSecond = parseJsonOutput(activateSecondResult.stdout);
  assert.equal(activatedSecond.ok, true);
  assert.equal(activatedSecond.current.releaseId, secondReleaseId);
  assert.equal(activatedSecond.previous.releaseId, firstReleaseId);
  assert.equal(
    activatedSecond.receipt.lineage.promotedFromReleaseId,
    firstReleaseId,
  );
  assert.equal(activatedSecond.receipt.phaseEvidence.preActivate.status, "succeeded");
  assert.equal(activatedSecond.receipt.phaseEvidence.postActivate.status, "succeeded");
  assert.deepEqual(await readLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
  ]);

  const unconfirmedRollbackResult = await runCli(
    tempRoot,
    [
      "release",
      "rollback",
      "lifeline-pilot",
    ],
    {
      LIFELINE_RELEASE_CONFIRMATION_CONTEXT: "interactive",
    },
  );
  assert.equal(unconfirmedRollbackResult.code, 1);
  assert.match(
    unconfirmedRollbackResult.stderr,
    /Re-run with:\s+lifeline release rollback lifeline-pilot --yes/,
  );

  const rollbackResult = await runCli(tempRoot, [
    "release",
    "rollback",
    "lifeline-pilot",
    "--yes",
  ]);
  assert.equal(rollbackResult.code, 0, rollbackResult.stderr);
  const rolledBack = parseJsonOutput(rollbackResult.stdout);
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.current.releaseId, firstReleaseId);
  assert.equal(rolledBack.previous.releaseId, secondReleaseId);
  assert.equal(rolledBack.receipt.action, "rollback");
  assert.equal(rolledBack.receipt.status, "succeeded");
  assert.equal(rolledBack.receipt.phaseEvidence.preRollback.status, "succeeded");
  assert.deepEqual(await readLogLines(hookLogPath), [
    "preActivate",
    "postActivate",
    "preActivate",
    "postActivate",
    "preRollback",
  ]);

  console.log("Wave 1 release CLI deterministic verification passed.");
} finally {
  // Leave no repo-local runtime residue behind after the deterministic run.
  await import("node:fs/promises").then(({ rm }) =>
    rm(tempRoot, { recursive: true, force: true }),
  );
}
