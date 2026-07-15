import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readStatusLine(output, prefix) {
  const line = output.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

async function runLifeline(cwd, ...args) {
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: process.env,
  });
  if (stderr.trim().length > 0) {
    throw new Error(`Unexpected stderr for startup ${args.join(' ')}: ${stderr.trim()}`);
  }
  return stdout;
}

async function readStartupState(cwd) {
  const statePath = path.join(cwd, '.lifeline', 'startup.json');
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

async function queryWindowsTaskXml() {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('schtasks.exe', [
      '/Query',
      '/TN',
      'LifelineRestoreAtLogon',
      '/XML',
      'ONE',
    ]);
    return stdout;
  } catch {
    return '';
  }
}

async function cleanupOwnedWindowsTask(cwd) {
  const taskXml = await queryWindowsTaskXml();
  if (!taskXml) return;
  const ownershipMarker = `Managed by Lifeline Windows startup v3. Root: ${cwd}`;
  assert(
    taskXml.includes(ownershipMarker),
    'Roundtrip cleanup refused to remove a pre-existing or foreign Windows task.',
  );
  await runLifeline(cwd, 'startup', 'disable');
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-startup-roundtrip-'));
  assert(
    !(await queryWindowsTaskXml()),
    'Deterministic startup roundtrip requires the stable Windows task identity to be absent.',
  );

  try {
  const enableOutput = await runLifeline(tempDir, 'startup', 'enable');
  assert(enableOutput.includes('Startup intent enabled.'), 'Expected startup enable confirmation.');

  const enabledState = await readStartupState(tempDir);
  assert(enabledState.intent === 'enabled', `Expected enabled intent, got ${enabledState.intent}`);
  assert(
    enabledState.restoreEntrypoint === 'lifeline restore',
    `Expected canonical restore entrypoint, got ${enabledState.restoreEntrypoint}`,
  );

  const statusOutput = await runLifeline(tempDir, 'startup', 'status');
  // Linux now has a real startup backend, so roundtrip checks must assert seam invariants
  // rather than contract-only fallback expectations.
  assert(
    statusOutput.includes('Startup supported: '),
    'Expected startup status to include supported signal.',
  );
  assert(
    statusOutput.includes('Startup enabled: '),
    'Expected startup status to include enabled signal.',
  );
  const backendStatus = readStatusLine(statusOutput, 'Startup backend status: ');
  assert(
    backendStatus === 'installed' ||
      backendStatus === 'not-installed' ||
      backendStatus === 'unsupported',
    `Expected startup backend status to be installed|not-installed|unsupported, got ${backendStatus}.`,
  );
  assert(
    statusOutput.includes('- restore entrypoint: lifeline restore'),
    'Expected startup status restore entrypoint to remain canonical.',
  );
  const mechanism = readStatusLine(statusOutput, '- mechanism: ');
  assert(mechanism.length > 0, 'Expected startup status to report non-empty mechanism line.');

  const disableOutput = await runLifeline(tempDir, 'startup', 'disable');
  assert(disableOutput.includes('Startup intent disabled.'), 'Expected startup disable confirmation.');

  const disabledState = await readStartupState(tempDir);
  assert(disabledState.intent === 'disabled', `Expected disabled intent, got ${disabledState.intent}`);

  const statePath = path.join(tempDir, '.lifeline', 'startup.json');
  await writeFile(statePath, '{"intent":', 'utf8');
  const recoveredStatusOutput = await runLifeline(tempDir, 'startup', 'status');
  assert(
    recoveredStatusOutput.includes('Startup supported: ') &&
      recoveredStatusOutput.includes('Startup enabled: ') &&
      recoveredStatusOutput.includes('Startup backend status: '),
    'Expected startup status to recover from malformed startup state with canonical status surface.',
  );

  console.log('Deterministic startup roundtrip verification passed (enable/status/disable).');
  } finally {
    await cleanupOwnedWindowsTask(tempDir);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup roundtrip verification failed: ${message}`);
  process.exitCode = 1;
});
