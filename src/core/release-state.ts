import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface ReleasePointer {
  releaseId: string;
  updatedAt: string;
  reason?: string;
}

export interface ReleaseRecord {
  releaseId: string;
  updatedAt: string;
  reason?: string;
  artifactRef?: string;
  metadataPath?: string;
}

export interface ReleaseRollbackTarget {
  releaseId: string;
  artifactRef: string;
  strategy: string;
  note?: string;
}

export interface ReleaseReceiptSummary {
  receiptId: string;
  action: string;
  status: string;
  releaseId: string;
  createdAt?: string;
  path: string;
}

export interface ReleaseOperatorEvidence {
  current?: ReleaseRecord;
  previous?: ReleaseRecord;
  rollbackTarget?: ReleaseRollbackTarget;
  receiptsDir: string;
  latestReceipts: ReleaseReceiptSummary[];
}

interface ReleaseMetadataLike {
  artifactRef?: string;
  rollbackTarget?: ReleaseRollbackTarget;
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

async function readReleasePointer(filePath: string): Promise<ReleasePointer | undefined> {
  const parsed = await readJsonIfPresent(filePath);
  if (!isRecord(parsed)) {
    return undefined;
  }

  if (!isNonEmptyString(parsed.releaseId) || !isNonEmptyString(parsed.updatedAt)) {
    return undefined;
  }

  return {
    releaseId: parsed.releaseId,
    updatedAt: parsed.updatedAt,
    ...(isNonEmptyString(parsed.reason) ? { reason: parsed.reason } : {}),
  };
}

async function readReleaseMetadata(
  metadataPath: string,
): Promise<ReleaseMetadataLike | undefined> {
  const parsed = await readJsonIfPresent(metadataPath);
  if (!isRecord(parsed)) {
    return undefined;
  }

  const metadata: ReleaseMetadataLike = {};
  if (isNonEmptyString(parsed.artifactRef)) {
    metadata.artifactRef = parsed.artifactRef;
  }

  if (isRecord(parsed.rollbackTarget)) {
    const rollbackTarget = parsed.rollbackTarget;
    if (
      isNonEmptyString(rollbackTarget.releaseId) &&
      isNonEmptyString(rollbackTarget.artifactRef) &&
      isNonEmptyString(rollbackTarget.strategy)
    ) {
      metadata.rollbackTarget = {
        releaseId: rollbackTarget.releaseId,
        artifactRef: rollbackTarget.artifactRef,
        strategy: rollbackTarget.strategy,
        ...(isNonEmptyString(rollbackTarget.note)
          ? { note: rollbackTarget.note }
          : {}),
      };
    }
  }

  return metadata;
}

async function readReleaseRecord(
  rootDir: string,
  appName: string,
  pointer: ReleasePointer | undefined,
): Promise<ReleaseRecord | undefined> {
  if (!pointer) {
    return undefined;
  }

  const metadataPath = path.join(
    rootDir,
    ".lifeline",
    "releases",
    appName,
    pointer.releaseId,
    "metadata.json",
  );
  const metadata = await readReleaseMetadata(metadataPath);

  return {
    releaseId: pointer.releaseId,
    updatedAt: pointer.updatedAt,
    ...(pointer.reason ? { reason: pointer.reason } : {}),
    ...(metadata?.artifactRef ? { artifactRef: metadata.artifactRef } : {}),
    ...(metadata ? { metadataPath: normalizeRelativePath(rootDir, metadataPath) } : {}),
  };
}

async function readLatestReceipts(
  rootDir: string,
  receiptsDir: string,
): Promise<ReleaseReceiptSummary[]> {
  const entries = (await readdir(receiptsDir).catch(() => [])) as string[];
  const receipts: Array<ReleaseReceiptSummary & { sortAt: number }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const receiptPath = path.join(receiptsDir, entry);
    const parsed = await readJsonIfPresent(receiptPath);
    if (!isRecord(parsed)) {
      continue;
    }

    if (
      !isNonEmptyString(parsed.receiptId) ||
      !isNonEmptyString(parsed.action) ||
      !isNonEmptyString(parsed.status) ||
      !isNonEmptyString(parsed.releaseId)
    ) {
      continue;
    }

    const createdAt =
      isNonEmptyString(parsed.createdAt) ? parsed.createdAt : undefined;
    const sortAt = createdAt ? Date.parse(createdAt) : Number.NaN;

    receipts.push({
      receiptId: parsed.receiptId,
      action: parsed.action,
      status: parsed.status,
      releaseId: parsed.releaseId,
      ...(createdAt ? { createdAt } : {}),
      path: normalizeRelativePath(rootDir, receiptPath),
      sortAt: Number.isNaN(sortAt) ? 0 : sortAt,
    });
  }

  return receipts
    .sort((left, right) => right.sortAt - left.sortAt)
    .slice(0, 3)
    .map(({ sortAt: _sortAt, ...receipt }) => receipt);
}

export async function readReleaseOperatorEvidence(
  appName: string,
  rootDir = process.cwd(),
): Promise<ReleaseOperatorEvidence | undefined> {
  const resolvedRoot = path.resolve(rootDir);
  const appReleaseRoot = path.join(resolvedRoot, ".lifeline", "releases", appName);
  const currentPointerPath = path.join(appReleaseRoot, "current.json");
  const previousPointerPath = path.join(appReleaseRoot, "previous.json");
  const receiptsDir = path.join(appReleaseRoot, "receipts");

  const [currentPointer, previousPointer] = await Promise.all([
    readReleasePointer(currentPointerPath),
    readReleasePointer(previousPointerPath),
  ]);

  const [current, previous] = await Promise.all([
    readReleaseRecord(resolvedRoot, appName, currentPointer),
    readReleaseRecord(resolvedRoot, appName, previousPointer),
  ]);

  const currentMetadata = current?.metadataPath
    ? await readReleaseMetadata(path.join(resolvedRoot, current.metadataPath))
    : undefined;
  const latestReceipts = await readLatestReceipts(resolvedRoot, receiptsDir);

  if (!current && !previous && latestReceipts.length === 0) {
    return undefined;
  }

  return {
    ...(current ? { current } : {}),
    ...(previous ? { previous } : {}),
    ...(currentMetadata?.rollbackTarget
      ? { rollbackTarget: currentMetadata.rollbackTarget }
      : {}),
    receiptsDir: normalizeRelativePath(resolvedRoot, receiptsDir),
    latestReceipts,
  };
}
