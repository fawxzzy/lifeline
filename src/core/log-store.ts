import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { getLifelineStateDirectory } from "./lifeline-root.js";

export async function ensureLogDirectory(): Promise<string> {
  const logsDirectory = path.join(getLifelineStateDirectory(), "logs");
  await mkdir(logsDirectory, { recursive: true });
  return logsDirectory;
}

export async function getLogPath(appName: string): Promise<string> {
  const logsDir = await ensureLogDirectory();
  return path.join(logsDir, `${appName}.log`);
}

export async function appendLogHeader(
  logPath: string,
  line: string,
): Promise<void> {
  const handle = await open(logPath, "a");
  await handle.appendFile(`${line}\n`);
  await handle.close();
}

export async function tailLogFile(
  logPath: string,
  lineCount: number,
): Promise<string[]> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-lineCount);
}
