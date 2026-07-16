import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const originalRuntimeRoot = process.env.LIFELINE_ROOT;
const ownedRuntimeRoot = originalRuntimeRoot
  ? undefined
  : await mkdtemp(path.join(tmpdir(), "lifeline-down-crash-loop-state-"));
if (ownedRuntimeRoot) {
  process.env.LIFELINE_ROOT = ownedRuntimeRoot;
}
const runtimeRoot = path.resolve(process.env.LIFELINE_ROOT ?? process.cwd());
const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-down-crash-loop-${uniqueSuffix}`;

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

function reserveUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a deterministic unused port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for pid ${child.pid} to exit.`)),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const stateStore = await import(
  new URL("../dist/core/state-store.js", import.meta.url)
);
const { getAppState, removeAppState, upsertAppState } = stateStore;
const supervisor = spawn(
  process.execPath,
  ["--eval", "setInterval(() => undefined, 1000)"],
  { stdio: "ignore", windowsHide: true },
);

try {
  if (!supervisor.pid) {
    throw new Error("Expected a deterministic supervisor fixture pid.");
  }
  const runtimePort = await reserveUnusedPort();
  const supervisorPid = supervisor.pid;
  await upsertAppState({
    name: appName,
    manifestPath: path.join(runtimeRoot, "fixtures", `${appName}.yml`),
    playbookPath: undefined,
    workingDirectory: runtimeRoot,
    supervisorPid,
    childPid: undefined,
    wrapperPid: undefined,
    listenerPid: undefined,
    portOwnerPid: undefined,
    port: runtimePort,
    healthcheckPath: "/healthz",
    logPath: path.join(runtimeRoot, ".lifeline", "logs", `${appName}.log`),
    startedAt: new Date().toISOString(),
    lastKnownStatus: "crash-loop",
    restartPolicy: "on-failure",
    restartCount: 5,
    lastExitCode: 17,
    lastExitAt: new Date().toISOString(),
    restorable: true,
    crashLoopDetected: true,
    blockedReason: "restart threshold exceeded",
  });

  const downResult = await run(["down", appName], { allowFailure: true });
  if (downResult.code !== 0) {
    throw new Error(
      `Expected down to succeed for same-PID crash-loop state.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }
  await waitForExit(supervisor);

  const persistedAfterDown = await getAppState(appName);
  if (
    persistedAfterDown?.supervisorPid !== supervisorPid ||
    persistedAfterDown.lastKnownStatus !== "stopped" ||
    persistedAfterDown.crashLoopDetected !== false ||
    persistedAfterDown.blockedReason !== undefined
  ) {
    throw new Error(
      `Expected successful same-PID down to retain identity and clear transient crash-loop markers, found ${JSON.stringify(persistedAfterDown)}.`,
    );
  }
  if (
    persistedAfterDown.restartCount !== 5 ||
    persistedAfterDown.lastExitCode !== 17
  ) {
    throw new Error(
      "Expected successful same-PID down to preserve restart and exit history.",
    );
  }

  const statusAfterDown = await run(["status", appName], {
    allowFailure: true,
  });
  if (!statusAfterDown.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected status after down to report stopped for crash-loop cleanup.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
    );
  }

  console.log(
    "Same-PID crash-loop down marker cleanup deterministic verification passed.",
  );
} finally {
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGTERM");
    await waitForExit(supervisor).catch(() => undefined);
  }
  await removeAppState(appName).catch(() => undefined);
  if (ownedRuntimeRoot) {
    await rm(ownedRuntimeRoot, { recursive: true, force: true });
  }
}
