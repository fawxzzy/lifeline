import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(repoRoot, "dist", "cli.js");
const sourceStateDirectory = path.join(repoRoot, ".lifeline");
const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-root-contract-"),
);
const externalHome = path.join(tempRoot, "external-home");
const originalRoot = process.env.LIFELINE_ROOT;
const originalAtlasRoot = process.env.ATLAS_ROOT;

const rootModule = await import("../dist/core/lifeline-root.js");
const stateModule = await import("../dist/core/state-store.js");
const logModule = await import("../dist/core/log-store.js");
const startupModule = await import("../dist/core/startup-contract.js");
const processManagerModule = await import("../dist/core/process-manager.js");
const privilegedModule = await import("../dist/core/privileged-execution.js");
const proofModule = await import("../dist/core/ui-proof-receipt.js");

function cleanCliEnvironment(overrides = {}) {
  const env = {
    ...process.env,
    npm_config_user_agent: "pnpm/10.6.5 node/v22.14.0",
    npm_execpath: "pnpm",
    ...overrides,
  };

  if (!("LIFELINE_ROOT" in overrides)) {
    Reflect.deleteProperty(env, "LIFELINE_ROOT");
  }

  return env;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: cleanCliEnvironment(options.env ?? {}),
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for detached child proof at ${filePath}`);
}

try {
  assert.equal(
    await pathExists(sourceStateDirectory),
    false,
    "the source checkout must begin without mutable Lifeline state",
  );

  Reflect.deleteProperty(process.env, "LIFELINE_ROOT");
  const defaultResolution = rootModule.resolveLifelineRoot({ cwd: repoRoot });
  assert.equal(defaultResolution.home, path.resolve(repoRoot));
  assert.equal(
    defaultResolution.stateDirectory,
    path.join(repoRoot, ".lifeline"),
  );
  assert.equal(defaultResolution.source, "cwd");

  const relativeResolution = rootModule.resolveLifelineRoot({
    envRoot: "relative-runtime-home",
    cwd: repoRoot,
  });
  assert.equal(
    relativeResolution.home,
    path.resolve(repoRoot, "relative-runtime-home"),
  );

  const configuredEnvironment = {
    LIFELINE_ROOT: path.join(tempRoot, "env-home"),
    ATLAS_ROOT: path.join(tempRoot, "atlas-root-sentinel"),
  };
  const configured = rootModule.configureLifelineInvocation({
    argv: ["doctor", `--root=${externalHome}`],
    env: configuredEnvironment,
    cwd: repoRoot,
  });
  assert.equal(configured.home, path.resolve(externalHome));
  assert.equal(configured.source, "cli");
  assert.deepEqual(configured.argv, ["doctor"]);
  assert.equal(configuredEnvironment.LIFELINE_ROOT, path.resolve(externalHome));
  assert.equal(
    configuredEnvironment.ATLAS_ROOT,
    path.join(tempRoot, "atlas-root-sentinel"),
    "runtime-home configuration must not redirect Atlas discovery",
  );
  assert.equal(
    process.cwd(),
    repoRoot,
    "runtime-home configuration must not change cwd",
  );

  assert.throws(
    () =>
      rootModule.configureLifelineInvocation({
        argv: ["doctor", "--root"],
        env: {},
        cwd: repoRoot,
      }),
    /Missing value for --root\. Use --root <path> or --root=<path>\./,
  );
  assert.throws(
    () =>
      rootModule.configureLifelineInvocation({
        argv: ["doctor", "--root="],
        env: {},
        cwd: repoRoot,
      }),
    /The --root value must be a non-empty filesystem path\./,
  );
  assert.throws(
    () =>
      rootModule.configureLifelineInvocation({
        argv: ["doctor", "--root-path"],
        env: {},
        cwd: repoRoot,
      }),
    /Malformed root option: --root-path\./,
  );
  assert.throws(
    () =>
      rootModule.resolveLifelineRoot({
        envRoot: "",
        cwd: repoRoot,
      }),
    /LIFELINE_ROOT must be a non-empty filesystem path\./,
  );

  const envDoctor = runCli(["doctor"], {
    env: { LIFELINE_ROOT: "relative-env-home" },
  });
  assert.equal(envDoctor.status, 0, combinedOutput(envDoctor));
  assert.match(
    envDoctor.stdout,
    new RegExp(
      `Resolved Lifeline home: ${path.resolve(repoRoot, "relative-env-home").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );

  const cliDoctorHome = path.join(tempRoot, "cli-doctor-home");
  const cliDoctor = runCli(["--root", cliDoctorHome, "doctor"], {
    env: { LIFELINE_ROOT: path.join(tempRoot, "ignored-env-home") },
  });
  assert.equal(cliDoctor.status, 0, combinedOutput(cliDoctor));
  assert.ok(
    cliDoctor.stdout.includes(
      `Resolved Lifeline home: ${path.resolve(cliDoctorHome)}`,
    ),
    combinedOutput(cliDoctor),
  );
  assert.ok(
    cliDoctor.stdout.includes(
      `Resolved Lifeline state directory: ${path.join(path.resolve(cliDoctorHome), ".lifeline")}`,
    ),
    combinedOutput(cliDoctor),
  );
  assert.equal(
    await pathExists(cliDoctorHome),
    false,
    "doctor must not create the selected home or state directory",
  );

  for (const args of [
    ["doctor", "--root"],
    ["doctor", "--root="],
    ["doctor", "--root-path"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(combinedOutput(result), /--root/);
    assert.match(
      combinedOutput(result),
      /Use --root <path> or --root=<path>\./,
    );
  }

  process.env.LIFELINE_ROOT = externalHome;
  const expectedStateDirectory = path.join(externalHome, ".lifeline");
  const expectedReceiptsDirectory = path.join(
    expectedStateDirectory,
    "receipts",
  );

  await stateModule.writeState({ apps: {} });
  assert.equal(
    await stateModule.getStatePath(),
    path.join(expectedStateDirectory, "state.json"),
  );
  assert.equal(
    await pathExists(path.join(expectedStateDirectory, "state.json")),
    true,
  );

  const logPath = await logModule.getLogPath("runtime-home-contract");
  assert.equal(
    logPath,
    path.join(expectedStateDirectory, "logs", "runtime-home-contract.log"),
  );
  await logModule.appendLogHeader(logPath, "runtime-home proof");
  assert.equal(await pathExists(logPath), true);

  await startupModule.setStartupIntent("enabled", "installed");
  assert.equal(
    await pathExists(path.join(expectedStateDirectory, "startup.json")),
    true,
  );

  assert.equal(
    privilegedModule.resolvePrivilegedExecutionReceiptDirectory(),
    expectedReceiptsDirectory,
  );
  const receiptOverride = path.join(tempRoot, "receipt-override");
  assert.equal(
    privilegedModule.resolvePrivilegedExecutionReceiptDirectory(
      receiptOverride,
    ),
    receiptOverride,
    "--receipt-dir must remain the more-specific override",
  );
  assert.equal(
    proofModule.resolveUiProofPassedReceiptDirectory({
      sourceRepoId: "playbook",
      trancheId: "observer",
    }),
    path.join(
      expectedReceiptsDirectory,
      "proof-passed",
      "playbook",
      "observer",
    ),
  );
  assert.equal(
    proofModule.resolveUiProofPassedReceiptDirectory({
      sourceRepoId: "playbook",
      trancheId: "observer",
      receiptDir: receiptOverride,
    }),
    receiptOverride,
  );

  const releaseHookProofPath = path.join(tempRoot, "release-hook-cwd.txt");
  const releaseHookProgram = Buffer.from(
    `require("node:fs").writeFileSync(${JSON.stringify(releaseHookProofPath)}, process.cwd(), "utf8")`,
    "utf8",
  ).toString("base64");
  const releaseManifest = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "control-plane",
        "fixtures",
        "wave1-pilot-deploy.manifest.json",
      ),
      "utf8",
    ),
  );
  releaseManifest.migrationHooks.preActivate = [
    `${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${releaseHookProgram}','base64').toString())"`,
  ];
  const releaseManifestPath = path.join(tempRoot, "runtime-home-release.json");
  await writeFile(
    releaseManifestPath,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    "utf8",
  );

  const releaseResult = runCli(["release", "persist", releaseManifestPath], {
    env: { LIFELINE_ROOT: externalHome },
  });
  assert.equal(releaseResult.status, 0, combinedOutput(releaseResult));
  const releaseOutput = JSON.parse(releaseResult.stdout);
  assert.equal(releaseOutput.rootDir, repoRoot.replace(/\\/g, "/"));
  assert.equal(releaseOutput.stateRootDir, externalHome.replace(/\\/g, "/"));
  assert.equal(
    await pathExists(
      path.join(expectedStateDirectory, "releases", "lifeline-pilot"),
    ),
    true,
  );
  const activationResult = runCli(
    [
      "release",
      "activate",
      releaseOutput.appName,
      releaseOutput.releaseId,
      "--yes",
    ],
    { env: { LIFELINE_ROOT: externalHome } },
  );
  assert.equal(activationResult.status, 0, combinedOutput(activationResult));
  assert.equal(
    await readFile(releaseHookProofPath, "utf8"),
    repoRoot,
    "external release state must not redirect release hook working directories",
  );

  const validateResult = runCli(
    ["validate", "examples/fitness-app.lifeline.yml", `--root=${externalHome}`],
    { cwd: repoRoot },
  );
  assert.equal(validateResult.status, 0, combinedOutput(validateResult));
  assert.match(validateResult.stdout, /manifest is valid:/i);
  assert.equal(
    process.cwd(),
    repoRoot,
    "application path resolution must remain based on the invoking cwd",
  );

  const detachedProofPath = path.join(tempRoot, "detached-root-proof.txt");
  const detachedEnvironment = cleanCliEnvironment({
    LIFELINE_ROOT: "relative-detached-home",
  });
  rootModule.configureLifelineInvocation({
    argv: ["restore"],
    env: detachedEnvironment,
    cwd: repoRoot,
  });
  const detachedProgram = Buffer.from(
    `require("node:fs").writeFileSync(${JSON.stringify(detachedProofPath)}, process.env.LIFELINE_ROOT, "utf8")`,
    "utf8",
  ).toString("base64");
  await processManagerModule.startDetachedCommand({
    command: `${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${detachedProgram}','base64').toString())"`,
    cwd: repoRoot,
    env: detachedEnvironment,
    label: "LIFELINE_ROOT inheritance proof",
  });
  await waitForFile(detachedProofPath);
  assert.equal(
    await readFile(detachedProofPath, "utf8"),
    path.resolve(repoRoot, "relative-detached-home"),
    "detached supervisors must inherit an absolute LIFELINE_ROOT",
  );

  assert.equal(
    await pathExists(sourceStateDirectory),
    false,
    "external runtime-home operations must not create source-checkout state",
  );

  console.log("Lifeline runtime-home deterministic verification passed.");
} finally {
  if (originalRoot === undefined) {
    Reflect.deleteProperty(process.env, "LIFELINE_ROOT");
  } else {
    process.env.LIFELINE_ROOT = originalRoot;
  }
  if (originalAtlasRoot === undefined) {
    Reflect.deleteProperty(process.env, "ATLAS_ROOT");
  } else {
    process.env.ATLAS_ROOT = originalAtlasRoot;
  }
  await rm(tempRoot, { recursive: true, force: true });
}
