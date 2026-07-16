import { spawn } from "node:child_process";
import { open, readdir, readFile, readlink } from "node:fs/promises";
import { createConnection } from "node:net";

import { ProcessManagerError } from "./errors.js";

export interface RunCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

export interface StartBackgroundOptions extends RunCommandOptions {
  logPath: string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

async function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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
      resolve({ code, stdout, stderr });
    });
  });
}

async function findListeningPortOwnerPidFromProc(
  port: number,
): Promise<number | undefined> {
  const parseListeningInodes = async (
    tablePath: string,
  ): Promise<Set<string>> => {
    const raw = await readFile(tablePath, "utf8").catch(() => "");
    if (!raw) {
      return new Set<string>();
    }

    const lines = raw.split(/\r?\n/).slice(1);
    const targetPortHex = port.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length < 10) {
        continue;
      }
      const localAddress = parts[1] ?? "";
      const state = parts[3];
      const inode = parts[9];
      const localPortHex = localAddress.split(":")[1]?.toUpperCase();
      if (state === "0A" && localPortHex === targetPortHex && inode) {
        inodes.add(inode);
      }
    }

    return inodes;
  };

  const inodes = new Set<string>([
    ...(await parseListeningInodes("/proc/net/tcp")),
    ...(await parseListeningInodes("/proc/net/tcp6")),
  ]);
  if (inodes.size === 0) {
    return undefined;
  }

  const procEntries = await readdir("/proc", { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of procEntries) {
    if (
      typeof entry === "string" ||
      !entry.isDirectory() ||
      !/^\d+$/.test(entry.name)
    ) {
      continue;
    }

    const pid = Number(entry.name);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    const fdDir = `/proc/${entry.name}/fd`;
    const fdEntries = await readdir(fdDir).catch(() => []);
    for (const fdEntry of fdEntries) {
      if (typeof fdEntry !== "string") {
        continue;
      }
      const target = await readlink(`${fdDir}/${fdEntry}`).catch(() => "");
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match?.[1] && inodes.has(match[1])) {
        return pid;
      }
    }
  }

  return undefined;
}

export async function runForegroundCommand(
  options: RunCommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new ProcessManagerError(
          `${options.label} failed in ${options.cwd} with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

export async function startBackgroundProcess(
  options: StartBackgroundOptions,
): Promise<number> {
  const logHandle = await open(options.logPath, "a");

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached: !isWindows(),
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });

    child.on("error", async (error) => {
      await logHandle.close();
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("spawn", async () => {
      child.unref();
      await logHandle.close();
      if (!child.pid) {
        reject(
          new ProcessManagerError(
            `Failed to start ${options.label}: missing pid.`,
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

export async function startDetachedCommand(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached: !isWindows(),
      stdio: "ignore",
    });

    child.on("error", (error) => {
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("spawn", () => {
      child.unref();
      if (!child.pid) {
        reject(
          new ProcessManagerError(
            `Failed to start ${options.label}: missing pid.`,
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

export async function startDetachedExecutable(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: !isWindows(),
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", (error) => {
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("spawn", () => {
      child.unref();
      if (!child.pid) {
        reject(
          new ProcessManagerError(
            `Failed to start ${options.label}: missing pid.`,
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findListeningPortOwnerPid(
  port: number,
): Promise<number | undefined> {
  if (isWindows()) {
    const result = await runCapture("netstat", ["-ano", "-p", "tcp"]);
    if (result.code !== 0) {
      return undefined;
    }

    const lines = result.stdout.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("LISTENING")) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) {
        continue;
      }
      const localAddress = parts[1];
      const pidRaw = parts[4];
      if (!localAddress?.endsWith(`:${port}`)) {
        continue;
      }
      const pid = Number(pidRaw);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }

    return undefined;
  }

  const lsof = await runCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (lsof.code === 0) {
    const first = lsof.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      const pid = Number(first);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  }

  const ss = await runCapture("ss", ["-ltnp"])
    .catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (ss.code === 0) {
    const lines = ss.stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes(`:${port}`)) {
        continue;
      }
      const pidMatch = line.match(/pid=(\d+)/);
      if (!pidMatch) {
        continue;
      }
      const pid = Number(pidMatch[1]);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  }

  if (process.platform === "linux") {
    return await findListeningPortOwnerPidFromProc(port);
  }

  return undefined;
}

export async function waitForPortToClear(
  port: number,
  timeoutMs = 8_000,
): Promise<boolean> {
  async function isPortListening(targetPort: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: targetPort,
      });

      const finalize = (listening: boolean) => {
        socket.destroy();
        resolve(listening);
      };

      socket.setTimeout(300);
      socket.once("connect", () => finalize(true));
      socket.once("timeout", () => finalize(false));
      socket.once("error", () => {
        finalize(false);
      });
    });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ownerPid = await findListeningPortOwnerPid(port);
    if (!ownerPid && !(await isPortListening(port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const ownerPid = await findListeningPortOwnerPid(port);
  if (ownerPid) {
    return false;
  }

  return !(await isPortListening(port));
}

export async function stopProcess(pid: number): Promise<void> {
  if (!(await isProcessAlive(pid))) {
    return;
  }

  if (isWindows()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
      child.on("error", (error) =>
        reject(
          new ProcessManagerError(
            `Failed to stop pid ${pid}: ${error.message}`,
          ),
        ),
      );
      child.on("exit", (code) => {
        if (code === 0 || code === 128) {
          resolve();
          return;
        }
        reject(
          new ProcessManagerError(
            `taskkill failed for pid ${pid} with exit code ${code ?? "unknown"}.`,
          ),
        );
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown stop error";
      throw new ProcessManagerError(`Failed to stop pid ${pid}: ${message}`);
    }
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown kill error";
      throw new ProcessManagerError(
        `Failed to force stop pid ${pid}: ${message}`,
      );
    }
  }
}
