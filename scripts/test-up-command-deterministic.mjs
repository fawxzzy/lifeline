import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const fixtureDir = "fixtures/runtime-smoke-app";
const runId = `${Date.now()}-${process.pid}`;
const baseManifestName = "runtime-smoke-app.lifeline.yml";
let lifelineEnvironment = process.env;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function runCli(args, env = lifelineEnvironment, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      env,
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

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running lifeline ${args.join(" ")} after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: normalize(stdout),
        stderr: normalize(stderr),
      });
    });
  });
}

async function pickFreePort() {
  const net = await import("node:net");

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve dynamic port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function prepareFixture(tempRoot, appName, port) {
  const fixtureCopy = path.join(tempRoot, appName);
  await cp(fixtureDir, fixtureCopy, { recursive: true });

  const manifestPath = path.join(fixtureCopy, baseManifestName);
  const originalManifest = await readFile(manifestPath, "utf8");
  const patchedManifest = originalManifest
    .replace("name: runtime-smoke-app", `name: ${appName}`)
    .replace(/^port:\s*\d+/m, `port: ${port}`);
  await writeFile(manifestPath, patchedManifest, "utf8");

  const envPath = path.join(fixtureCopy, ".env.runtime");
  const originalEnv = await readFile(envPath, "utf8");
  await writeFile(envPath, originalEnv.replace(/^PORT=.*/m, `PORT=${port}`), "utf8");

  return { manifestPath, envPath };
}

function assertNoSuccessSurface(name, result) {
  assert(
    !result.stdout.includes(" is running."),
    `${name}: expected stdout to avoid success running surface, received:\n${result.stdout}`,
  );
  assert(
    !result.stdout.includes("- health:"),
    `${name}: expected stdout to avoid success health summary, received:\n${result.stdout}`,
  );
  assert(
    !result.stderr.includes(" is running."),
    `${name}: expected stderr to avoid success running surface, received:\n${result.stderr}`,
  );
  assert(
    !result.stdout.includes("Starting supervisor for"),
    `${name}: expected stdout to avoid supervisor startup line, received:\n${result.stdout}`,
  );
  assert(
    !result.stdout.includes("Installing "),
    `${name}: expected stdout to avoid install step on early failure, received:\n${result.stdout}`,
  );
  assert(
    !result.stdout.includes("Building "),
    `${name}: expected stdout to avoid build step on early failure, received:\n${result.stdout}`,
  );
}

function extractSummaryLines(output) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "));
}

let tempRoot;
const startedApps = new Set();

try {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-up-command-deterministic-"));
  lifelineEnvironment = {
    ...process.env,
    LIFELINE_ROOT: tempRoot,
  };

  const missingEnvAppName = `runtime-up-missing-required-env-${runId}`;
  const missingEnvPort = await pickFreePort();
  const missingEnvFixture = await prepareFixture(tempRoot, missingEnvAppName, missingEnvPort);
  await writeFile(missingEnvFixture.envPath, `PORT=${missingEnvPort}\n`, "utf8");

  const missingEnvResult = await runCli(["up", missingEnvFixture.manifestPath]);
  assert(
    missingEnvResult.code === 1,
    `missing required env: expected exit code 1, got ${missingEnvResult.code}.`,
  );
  assert(
    missingEnvResult.stderr.includes("missing required environment keys: SMOKE_TOKEN"),
    `missing required env: expected validation message, got:\n${missingEnvResult.stderr}`,
  );
  assertNoSuccessSurface("missing required env", missingEnvResult);

  const malformedEnvAppName = `runtime-up-malformed-env-${runId}`;
  const malformedEnvPort = await pickFreePort();
  const malformedEnvFixture = await prepareFixture(tempRoot, malformedEnvAppName, malformedEnvPort);
  await writeFile(malformedEnvFixture.envPath, `PORT=${malformedEnvPort}\nMALFORMED_LINE\n`, "utf8");

  const malformedEnvResult = await runCli(["up", malformedEnvFixture.manifestPath]);
  assert(
    malformedEnvResult.code === 1,
    `malformed env: expected exit code 1, got ${malformedEnvResult.code}.`,
  );
  assert(
    malformedEnvResult.stderr.includes("Invalid env line"),
    `malformed env: expected parse/validation text, got:\n${malformedEnvResult.stderr}`,
  );
  assertNoSuccessSurface("malformed env", malformedEnvResult);

  const malformedManifestAppName = `runtime-up-malformed-manifest-deterministic-${runId}`;
  const malformedManifestPort = await pickFreePort();
  const malformedManifestFixture = await prepareFixture(
    tempRoot,
    malformedManifestAppName,
    malformedManifestPort,
  );
  await writeFile(
    malformedManifestFixture.manifestPath,
    [`name: ${malformedManifestAppName}`, `port: ${malformedManifestPort}`, "startCommand node server.js"].join(
      "\n",
    ),
    "utf8",
  );

  const malformedManifestResult = await runCli(["up", malformedManifestFixture.manifestPath]);
  assert(
    malformedManifestResult.code === 1,
    `malformed manifest: expected exit code 1, got ${malformedManifestResult.code}.`,
  );
  assert(
    malformedManifestResult.stderr.includes("Expected key/value pair") ||
      malformedManifestResult.stderr.includes("Could not parse YAML"),
    `malformed manifest: expected YAML parse/shape text, got:\n${malformedManifestResult.stderr}`,
  );
  assertNoSuccessSurface("malformed manifest", malformedManifestResult);

  const successAppName = `runtime-up-success-deterministic-${runId}`;
  const successPort = await pickFreePort();
  const successFixture = await prepareFixture(tempRoot, successAppName, successPort);

  const successResult = await runCli(["up", successFixture.manifestPath]);
  assert(successResult.code === 0, `success path: expected exit code 0, got ${successResult.code}.`);
  assert(
    successResult.stderr.trim().length === 0,
    `success path: expected empty stderr on successful up, got:\n${successResult.stderr}`,
  );
  assert(
    successResult.stdout.includes(`App ${successAppName} is running.`),
    `success path: expected running headline, got:\n${successResult.stdout}`,
  );
  assert(
    successResult.stdout.includes("- supervisor pid:"),
    `success path: expected supervisor pid summary, got:\n${successResult.stdout}`,
  );
  assert(
    successResult.stdout.includes(`- port: ${successPort}`),
    `success path: expected configured port summary, got:\n${successResult.stdout}`,
  );
  assert(
    /- health:\s+(ok|200)/.test(successResult.stdout),
    `success path: expected health summary line, got:\n${successResult.stdout}`,
  );
  assert(
    successResult.stdout.includes(`Installing ${successAppName} in ${path.dirname(successFixture.manifestPath)}...`),
    `success path: expected install step summary, got:\n${successResult.stdout}`,
  );
  assert(
    successResult.stdout.includes(`Building ${successAppName} in ${path.dirname(successFixture.manifestPath)}...`),
    `success path: expected build step summary, got:\n${successResult.stdout}`,
  );
  assert(
    successResult.stdout.includes(`Starting supervisor for ${successAppName}...`),
    `success path: expected supervisor startup line, got:\n${successResult.stdout}`,
  );
  const successSummaryLines = extractSummaryLines(successResult.stdout);
  assert(
    successSummaryLines.length >= 5,
    `success path: expected summary block lines, got:\n${successResult.stdout}`,
  );

  startedApps.add(successAppName);

  console.log("Up command deterministic boundary verification passed.");
} finally {
  for (const appName of startedApps) {
    await runCli(["down", appName], lifelineEnvironment, 15000).catch(() => {});
  }

  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
