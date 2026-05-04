import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function extractReadmeCommands(readmeText) {
  const normalizedReadmeText = readmeText.replace(/\r\n/g, '\n');
  const commands = [];
  const codeBlockPattern = /```bash\n([\s\S]*?)```/g;
  for (const match of normalizedReadmeText.matchAll(codeBlockPattern)) {
    const block = match[1] ?? '';
    const mergedLines = [];
    let pending = '';

    for (const rawLine of block.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      if (pending) {
        pending = `${pending} ${trimmed}`;
      } else {
        pending = trimmed;
      }

      if (pending.endsWith('\\')) {
        pending = pending.slice(0, -1).trim();
        continue;
      }

      mergedLines.push(pending);
      pending = '';
    }

    if (pending) {
      mergedLines.push(pending);
    }

    for (const line of mergedLines) {
      if (line.startsWith('pnpm lifeline ')) {
        commands.push(line);
      }
    }
  }

  return commands;
}

function extractUsageLines(helpText) {
  return helpText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('lifeline '));
}

function parseLifelineInvocation(commandLine) {
  const parts = commandLine.trim().split(/\s+/);
  const lifelineIndex = parts.indexOf('lifeline');
  const command = parts[lifelineIndex + 1];
  const args = parts.slice(lifelineIndex + 2);
  return { command, args };
}

async function ensureBuiltCli(repoRoot) {
  const cliPath = path.join(repoRoot, 'dist', 'cli.js');
  try {
    await access(cliPath);
  } catch {
    throw new Error(
      'Missing dist/cli.js. Run `pnpm build` before README command-surface verification.',
    );
  }
  return cliPath;
}

async function runCli(cliPath, cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const exitError = /** @type {{ code?: number; stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof exitError.code === 'number' ? exitError.code : 1,
      stdout: exitError.stdout ?? '',
      stderr: exitError.stderr ?? '',
    };
  }
}

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const readmePath = path.join(repoRoot, 'README.md');
  const readmeText = await readFile(readmePath, 'utf8');
  const readmeCommands = extractReadmeCommands(readmeText);

  assert(readmeCommands.length > 0, 'Expected README to include pnpm lifeline command examples.');

  const cliPath = await ensureBuiltCli(repoRoot);
  const helpResult = await runCli(cliPath, repoRoot, ['--help']);
  assert(helpResult.code === 0, 'Expected `lifeline --help` to succeed.');

  const usageLines = extractUsageLines(`${helpResult.stdout}\n${helpResult.stderr}`);
  const usageText = usageLines.map((line) => normalizeWhitespace(line)).join('\n');
  const documentedCommands = new Set();

  for (const commandLine of readmeCommands) {
    const { command } = parseLifelineInvocation(commandLine);
    assert(command, `Unable to parse command from README line: ${commandLine}`);
    documentedCommands.add(command);

    const commandAppearsInUsage = usageLines.some((line) => line.startsWith(`lifeline ${command}`));
    assert(
      commandAppearsInUsage,
      `README command does not appear in CLI usage surface: ${commandLine}\nUsage:\n${usageText}`,
    );

    const manifestPath = commandLine.match(/\s([^\s]+\.lifeline\.yml)(?=\s|$)/)?.[1];
    if (manifestPath) {
      const resolvedPath = path.join(repoRoot, manifestPath);
      try {
        await access(resolvedPath);
      } catch {
        throw new Error(`README references missing manifest path: ${manifestPath}`);
      }
    }
  }

  const expectedDocumentedCommands = [
    'doctor',
    'validate',
    'resolve',
    'up',
    'status',
    'logs',
    'restart',
    'restore',
    'startup',
    'release',
    'execute',
    'proof-pass',
    'down',
  ];

  for (const command of expectedDocumentedCommands) {
    assert(
      documentedCommands.has(command),
      `README is missing documented command example for: lifeline ${command}`,
    );
  }

  const startupCommands = readmeCommands.filter((line) => line.startsWith('pnpm lifeline startup '));
  assert(startupCommands.length > 0, 'Expected README startup command examples.');

  const startupTempDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-readme-startup-'));
  try {
    for (const startupLine of startupCommands) {
      const { command, args } = parseLifelineInvocation(startupLine);
      const result = await runCli(cliPath, startupTempDir, [command, ...args]);
      assert(
        result.code === 0,
        `README startup command failed: ${startupLine}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
  } finally {
    await rm(startupTempDir, { recursive: true, force: true });
  }

  console.log('README command surface deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`README command surface deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
