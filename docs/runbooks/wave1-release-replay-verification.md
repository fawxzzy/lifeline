# Wave 1 Release Replay Verification

Use this runbook when operator evidence must prove that persisted Wave 1 release receipts still reconstruct the current and previous release pointers without relying on mutable in-memory state.

## Goal

Confirm that receipt history alone can replay the release lineage for one app:

- latest successful activation determines the current release
- the immediately prior promoted release becomes previous
- failed activation and rollback receipts preserve the existing pointer lineage
- pointer files can be checked against replayed lineage to detect drift or tampering

## Rule

Release pointer lineage must be reproducible from immutable receipt history, not only from the latest pointer files.

## Pattern

- replay receipts in chronological order
- reject malformed, duplicate-id, or wrong-version release receipts as degraded evidence instead of silently skipping them
- apply successful `activate` and `rollback` mutations to a derived current/previous state
- treat failed mutation receipts as evidence that pointers should not have moved
- compare replayed lineage to persisted pointer files and flag mismatches as degraded operator evidence

## Verification

Run:

```bash
node scripts/test-wave1-release-replay-deterministic.mjs
```

Then run the repo contract:

```bash
pnpm run verify
```

## Failure Mode

If pointer files drift, are hand-edited, or become partially stale, status surfaces can appear coherent while the immutable receipt log tells a different story. Hermetic replay catches that mismatch before operators trust the wrong release lineage.
