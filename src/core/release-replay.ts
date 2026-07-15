import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getLifelineRoot } from "./lifeline-root.js";

const WAVE1_RELEASE_RECEIPT_VERSION =
  "atlas.lifeline.release-receipt.v1";

export interface ReleaseReplayPointer {
  releaseId: string;
  updatedAt: string;
  reason: "activation" | "rollback";
}

export interface ReleaseReplayReceipt {
  receiptId: string;
  action: string;
  status: string;
  releaseId: string;
  createdAt: string;
  previousReleaseId?: string;
  preservedCurrentReleaseId?: string;
  preservedPreviousReleaseId?: string;
  path: string;
}

export interface ReleaseReplayResult {
  receiptsDir: string;
  replayedCurrent?: ReleaseReplayPointer;
  replayedPrevious?: ReleaseReplayPointer;
  appliedReceipts: ReleaseReplayReceipt[];
  issues: string[];
}

export interface ReleaseReplayVerificationResult extends ReleaseReplayResult {
  ok: boolean;
  persistedCurrent?: ReleaseReplayPointer;
  persistedPrevious?: ReleaseReplayPointer;
}

interface ReleaseReplayState {
  current?: ReleaseReplayPointer;
  previous?: ReleaseReplayPointer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function readReplayPointer(
  filePath: string,
): Promise<ReleaseReplayPointer | undefined> {
  const parsed = await readJsonIfPresent(filePath);
  if (!isRecord(parsed)) {
    return undefined;
  }

  if (
    !isNonEmptyString(parsed.releaseId) ||
    !isNonEmptyString(parsed.updatedAt) ||
    !isNonEmptyString(parsed.reason)
  ) {
    return undefined;
  }

  if (parsed.reason !== "activation" && parsed.reason !== "rollback") {
    return undefined;
  }

  return {
    releaseId: parsed.releaseId,
    updatedAt: parsed.updatedAt,
    reason: parsed.reason,
  };
}

async function readReplayReceipts(
  rootDir: string,
  appName: string,
): Promise<{ receipts: ReleaseReplayReceipt[]; issues: string[] }> {
  const receiptsDir = path.join(
    rootDir,
    ".lifeline",
    "releases",
    appName,
    "receipts",
  );
  const entries = (await readdir(receiptsDir).catch(() => [])) as string[];
  const receipts: Array<ReleaseReplayReceipt & { sortKey: string }> = [];
  const issues: string[] = [];
  const seenReceiptIds = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const receiptPath = path.join(receiptsDir, entry);
    const relativeReceiptPath = normalizeRelativePath(rootDir, receiptPath);
    const raw = await readFile(receiptPath, "utf8").catch(() => "");
    if (!raw) {
      issues.push(`release receipt ${relativeReceiptPath} is unreadable or empty`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      issues.push(`release receipt ${relativeReceiptPath} is not valid JSON`);
      continue;
    }

    if (
      !isRecord(parsed) ||
      !isNonEmptyString(parsed.contractVersion) ||
      !isNonEmptyString(parsed.receiptId) ||
      !isNonEmptyString(parsed.action) ||
      !isNonEmptyString(parsed.status) ||
      !isNonEmptyString(parsed.releaseId) ||
      !isNonEmptyString(parsed.createdAt)
    ) {
      issues.push(`release receipt ${relativeReceiptPath} does not match the Wave 1 receipt contract`);
      continue;
    }

    if (parsed.contractVersion !== WAVE1_RELEASE_RECEIPT_VERSION) {
      issues.push(
        `release receipt ${relativeReceiptPath} has unsupported contractVersion ${parsed.contractVersion}`,
      );
      continue;
    }

    const priorPath = seenReceiptIds.get(parsed.receiptId);
    if (priorPath) {
      issues.push(
        `duplicate release receipt id ${parsed.receiptId} in ${priorPath} and ${relativeReceiptPath}`,
      );
      continue;
    }
    seenReceiptIds.set(parsed.receiptId, relativeReceiptPath);

    receipts.push({
      receiptId: parsed.receiptId,
      action: parsed.action,
      status: parsed.status,
      releaseId: parsed.releaseId,
      createdAt: parsed.createdAt,
      ...(isNonEmptyString(parsed.previousReleaseId)
        ? { previousReleaseId: parsed.previousReleaseId }
        : {}),
      ...(isNonEmptyString(parsed.preservedCurrentReleaseId)
        ? { preservedCurrentReleaseId: parsed.preservedCurrentReleaseId }
        : {}),
      ...(isNonEmptyString(parsed.preservedPreviousReleaseId)
        ? { preservedPreviousReleaseId: parsed.preservedPreviousReleaseId }
        : {}),
      path: relativeReceiptPath,
      sortKey: `${parsed.createdAt}-${entry}`,
    });
  }

  return {
    receipts: receipts
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ sortKey: _sortKey, ...receipt }) => receipt),
    issues,
  };
}

function pointerIdsMatch(
  actual: ReleaseReplayPointer | undefined,
  expected: ReleaseReplayPointer | undefined,
): boolean {
  return actual?.releaseId === expected?.releaseId;
}

function applySucceededActivate(
  state: ReleaseReplayState,
  receipt: ReleaseReplayReceipt,
  issues: string[],
): ReleaseReplayState {
  if (
    state.current?.releaseId &&
    receipt.previousReleaseId &&
    state.current.releaseId !== receipt.previousReleaseId
  ) {
    issues.push(
      `activate receipt ${receipt.receiptId} expected previousReleaseId ${state.current.releaseId} but found ${receipt.previousReleaseId}`,
    );
  }

  const nextPreviousReleaseId =
    receipt.previousReleaseId ??
    (state.current?.releaseId && state.current.releaseId !== receipt.releaseId
      ? state.current.releaseId
      : state.previous?.releaseId);

  return {
    current: {
      releaseId: receipt.releaseId,
      updatedAt: receipt.createdAt,
      reason: "activation",
    },
    ...(nextPreviousReleaseId
      ? {
          previous: {
            releaseId: nextPreviousReleaseId,
            updatedAt: receipt.createdAt,
            reason: "activation",
          },
        }
      : {}),
  };
}

function applySucceededRollback(
  receipt: ReleaseReplayReceipt,
  issues: string[],
): ReleaseReplayState {
  if (!receipt.previousReleaseId) {
    issues.push(
      `rollback receipt ${receipt.receiptId} is missing previousReleaseId`,
    );
    return {
      current: {
        releaseId: receipt.releaseId,
        updatedAt: receipt.createdAt,
        reason: "rollback",
      },
    };
  }

  return {
    current: {
      releaseId: receipt.releaseId,
      updatedAt: receipt.createdAt,
      reason: "rollback",
    },
    previous: {
      releaseId: receipt.previousReleaseId,
      updatedAt: receipt.createdAt,
      reason: "rollback",
    },
  };
}

function verifyFailedReceiptPreservesState(
  state: ReleaseReplayState,
  receipt: ReleaseReplayReceipt,
  issues: string[],
): void {
  if (
    receipt.preservedCurrentReleaseId &&
    receipt.preservedCurrentReleaseId !== state.current?.releaseId
  ) {
    issues.push(
      `${receipt.action} failed receipt ${receipt.receiptId} preservedCurrentReleaseId ${receipt.preservedCurrentReleaseId} does not match replayed current ${state.current?.releaseId ?? "<none>"}`,
    );
  }

  if (
    receipt.preservedPreviousReleaseId &&
    receipt.preservedPreviousReleaseId !== state.previous?.releaseId
  ) {
    issues.push(
      `${receipt.action} failed receipt ${receipt.receiptId} preservedPreviousReleaseId ${receipt.preservedPreviousReleaseId} does not match replayed previous ${state.previous?.releaseId ?? "<none>"}`,
    );
  }
}

export async function replayWave1ReleaseReceipts(
  appName: string,
  rootDir = getLifelineRoot(),
): Promise<ReleaseReplayResult> {
  const resolvedRoot = path.resolve(rootDir);
  const receiptsDir = path.join(
    resolvedRoot,
    ".lifeline",
    "releases",
    appName,
    "receipts",
  );
  const { receipts, issues } = await readReplayReceipts(resolvedRoot, appName);
  let state: ReleaseReplayState = {};

  for (const receipt of receipts) {
    if (receipt.action === "activate") {
      if (receipt.status === "succeeded") {
        state = applySucceededActivate(state, receipt, issues);
        continue;
      }

      if (receipt.status === "failed") {
        verifyFailedReceiptPreservesState(state, receipt, issues);
        continue;
      }
    }

    if (receipt.action === "rollback") {
      if (receipt.status === "succeeded") {
        state = applySucceededRollback(receipt, issues);
        continue;
      }

      if (receipt.status === "failed") {
        verifyFailedReceiptPreservesState(state, receipt, issues);
        continue;
      }
    }
  }

  return {
    receiptsDir: normalizeRelativePath(resolvedRoot, receiptsDir),
    ...(state.current ? { replayedCurrent: state.current } : {}),
    ...(state.previous ? { replayedPrevious: state.previous } : {}),
    appliedReceipts: receipts,
    issues,
  };
}

export async function verifyWave1ReleaseReplay(
  appName: string,
  rootDir = getLifelineRoot(),
): Promise<ReleaseReplayVerificationResult> {
  const resolvedRoot = path.resolve(rootDir);
  const appReleaseRoot = path.join(
    resolvedRoot,
    ".lifeline",
    "releases",
    appName,
  );
  const [replayResult, persistedCurrent, persistedPrevious] = await Promise.all([
    replayWave1ReleaseReceipts(appName, resolvedRoot),
    readReplayPointer(path.join(appReleaseRoot, "current.json")),
    readReplayPointer(path.join(appReleaseRoot, "previous.json")),
  ]);
  const issues = [...replayResult.issues];

  if (!pointerIdsMatch(persistedCurrent, replayResult.replayedCurrent)) {
    issues.push(
      `current pointer mismatch: persisted=${persistedCurrent?.releaseId ?? "<none>"} replayed=${replayResult.replayedCurrent?.releaseId ?? "<none>"}`,
    );
  }

  if (!pointerIdsMatch(persistedPrevious, replayResult.replayedPrevious)) {
    issues.push(
      `previous pointer mismatch: persisted=${persistedPrevious?.releaseId ?? "<none>"} replayed=${replayResult.replayedPrevious?.releaseId ?? "<none>"}`,
    );
  }

  return {
    ok: issues.length === 0,
    receiptsDir: replayResult.receiptsDir,
    ...(replayResult.replayedCurrent
      ? { replayedCurrent: replayResult.replayedCurrent }
      : {}),
    ...(replayResult.replayedPrevious
      ? { replayedPrevious: replayResult.replayedPrevious }
      : {}),
    ...(persistedCurrent ? { persistedCurrent } : {}),
    ...(persistedPrevious ? { persistedPrevious } : {}),
    appliedReceipts: replayResult.appliedReceipts,
    issues,
  };
}
