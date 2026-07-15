import assert from "node:assert/strict";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const originalCwd = process.cwd();
const originalRoot = process.env.LIFELINE_ROOT;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-log-store-"));

try {
  Reflect.deleteProperty(process.env, "LIFELINE_ROOT");
  process.chdir(tempRoot);
  const { ensureLogDirectory, getLogPath, appendLogHeader, tailLogFile } =
    await import("../dist/core/log-store.js");

  const logsDir = path.join(tempRoot, ".lifeline", "logs");

  await assert.rejects(access(logsDir));

  const ensuredLogsDir = await ensureLogDirectory();
  assert.equal(ensuredLogsDir, logsDir);

  const directoryStats = await stat(ensuredLogsDir);
  assert.equal(directoryStats.isDirectory(), true);

  const appName = "deterministic-log-helper";
  const logPath = await getLogPath(appName);
  assert.equal(logPath, path.join(logsDir, `${appName}.log`));

  await appendLogHeader(logPath, "[alpha] first");
  await appendLogHeader(logPath, "[beta] second");
  await appendFile(logPath, "\n", "utf8");

  const rawLog = await readFile(logPath, "utf8");
  assert.equal(rawLog, "[alpha] first\n[beta] second\n\n");

  const tailOne = await tailLogFile(logPath, 1);
  assert.deepEqual(tailOne, ["[beta] second"]);

  const tailAllNonEmpty = await tailLogFile(logPath, 10);
  assert.deepEqual(tailAllNonEmpty, ["[alpha] first", "[beta] second"]);

  const missing = await tailLogFile(path.join(logsDir, "missing.log"), 5);
  assert.deepEqual(missing, []);

  console.log("log-store deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
  if (originalRoot === undefined) {
    Reflect.deleteProperty(process.env, "LIFELINE_ROOT");
  } else {
    process.env.LIFELINE_ROOT = originalRoot;
  }
  await rm(tempRoot, { recursive: true, force: true });
}
