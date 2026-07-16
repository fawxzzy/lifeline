import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-down-crash-loop-${uniqueSuffix}`;
const runtimePort = 7600 + Math.floor(Math.random() * 1000);

let manifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let tempRootDir;

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
            `Command failed: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function readRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForCrashLoopState() {
  for (let i = 0; i < 700; i += 1) {
    const state = await readRuntimeState();
    if (state?.lastKnownStatus === "crash-loop" && state.crashLoopDetected) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for crash-loop state.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(
    path.join(tmpdir(), "lifeline-runtime-down-crash-loop-smoke-"),
  );
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(
    envPath,
    envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`),
    "utf8",
  );

  const tempManifestPath = path.join(
    tempFixtureDir,
    "runtime-smoke-app.lifeline.yml",
  );
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForCrashLoopDown = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(
      /^startCommand: .*$/m,
      "startCommand: node -e \"const s=require('node:net').createServer();s.listen(Number(process.env.PORT||0),'127.0.0.1',()=>setTimeout(()=>process.exit(17),100));\"",
    )
    .replace(/^ {2}restartPolicy: .*$/m, "  restartPolicy: on-failure");

  await writeFile(tempManifestPath, manifestForCrashLoopDown, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath], { allowFailure: true });

  const crashLoopState = await waitForCrashLoopState();
  if (crashLoopState.lastKnownStatus !== "crash-loop") {
    throw new Error(
      `Expected crash-loop runtime state before down, found ${JSON.stringify(crashLoopState)}`,
    );
  }

  const downResult = await run(["down", appName], { allowFailure: true });
  if (downResult.code !== 0) {
    throw new Error(
      `Expected down to succeed for crash-loop app.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  if (
    downResult.stderr.includes(`No runtime state found for app ${appName}.`)
  ) {
    throw new Error(
      `Expected down not to take no-history path for crash-loop app.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(
      `Expected port ${runtimePort} to be free after crash-loop down`,
    );
  }

  const persistedAfterDown = await readRuntimeState();
  if (!persistedAfterDown) {
    throw new Error(
      "Expected persisted runtime state after down for crash-loop history",
    );
  }

  if (persistedAfterDown.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected down to converge crash-loop history to stopped, found ${persistedAfterDown.lastKnownStatus}`,
    );
  }

  if (persistedAfterDown.crashLoopDetected !== false) {
    throw new Error(
      `Expected successful down to clear the transient crash-loop marker, found ${persistedAfterDown.crashLoopDetected}`,
    );
  }

  if (persistedAfterDown.portOwnerPid) {
    throw new Error(
      `Expected persisted state after down to clear portOwnerPid, found ${persistedAfterDown.portOwnerPid}`,
    );
  }

  const statusAfterDown = await run(["status", appName], {
    allowFailure: true,
  });
  if (!statusAfterDown.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected status after down to report stopped for crash-loop cleanup path.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
    );
  }
} catch (error) {
  await cleanup();
  throw error;
} finally {
  await cleanup();
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
