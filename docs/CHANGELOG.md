# Changelog

## 2026-07-15

- Hardened Windows logon restore around one current-user Task Scheduler definition with explicit runtime-home arguments, a content-addressed stable launcher snapshot, limited run level, `IgnoreNew`, exact readback, idempotent re-enable, and foreign-task rejection.
- Added fail-closed startup terminal verification and narrowly versioned same-root ownership recognition so stale-running supervisor loss fails while recognized v2 tasks remain upgradeable and removable.
- Added byte-for-byte stable-launcher reuse checks plus state-aware registration rollback so corrupt snapshots self-repair and failed owned upgrades restore their exact prior task instead of deleting it.
- Tightened v4 Windows readback to the structurally exact declared Settings block and exactly one expected action, repairing safe owned drift while rejecting behavioral extras and multi-action definitions.
- Closed Windows startup transaction and multi-app failure gaps: exact single-trigger/principal ownership, verified create/delete reconciliation, honest retained-task status, partial-launch cleanup, and live hold-state correlation now fail closed with deterministic coverage.
- Rejected recursive Windows launcher source/destination overlap before snapshotting and deferred identity resolution until Task Scheduler availability is known.
- Made Windows enable dry-run predict the supported v2/v3 or safe-drift reconciliation path instead of misreporting it as blocked.
- Bound failed startup cleanup to the exact supervisor PIDs launched by that invocation so a newer replacement supervisor and its persisted state are never stopped or overwritten.
- Removed the optional `ONE` XML type token from exact-task Scheduler queries, retaining behavior on the proof host while aligning readback with the documented `/XML` flag form across Windows versions.
- Cleared transient crash-loop/blocked markers after successful PID-owned down while preserving them on failed down, and treated stable-launcher metadata symmetrically as generated non-payload content during hash/copy/compare.
- Made concurrent Windows startup enables converge end to end: unique verified staging plus a recoverable filesystem lease atomically publishes one byte-valid launcher, and a losing task create accepts the winner's exact v4 definition while non-exact or ambiguous readback is preserved without unproven deletion authority.
- Added bounded `restore --startup` semantics so enabled logon restoration can revive stopped/restorable apps without changing ordinary restore behavior, while a long-lived task wrapper preserves the supervised process tree until `lifeline down` completes.
- Completed the supervised Playbook restart and Windows logon-restore roadmap lanes with real manual Task Scheduler execution, stable runtime placement, canonical Observer health, singleton process proof, and clean stopped/task-enabled convergence.
- WHY: A short-lived scheduled restore action could otherwise lose its child supervisor when Task Scheduler closed the completed action tree, and a worktree-bound launcher or manifest would not survive owner worktree archival.
- Added the explicit Lifeline runtime-home placement contract with global `--root` forms, `LIFELINE_ROOT`, CLI-over-environment-over-cwd precedence, absolute child inheritance, and non-creating `doctor` path reporting.
- Redirected runtime state, logs, startup state, release state, privileged receipts, and proof receipts beneath `<resolved-home>/.lifeline/` while preserving application working directories, Atlas discovery, and `--receipt-dir` overrides.
- Added deterministic runtime-home proof and owner-roadmap follow-on lanes for supervised Playbook Observer restart and Windows logon restoration.
- WHY: Lifeline must supervise long-running local services without writing mutable state into a source checkout.

## 2026-05-20

- Added a release-safety closeout checkpoint covering merged Wave 1, Wave 2, and Wave 3 hardening across release replay evidence, destructive pointer confirmations, receipt health, replay proof, and rollback confidence.
- WHY: Lifeline reached a stable release/operator safety plateau and needed one bounded checkpoint before opening a new execution lane or switching focus to sustain work elsewhere in the stack.

## 2026-04-01

- Added deterministic Wave 2 startup verification (`pnpm test:startup-deterministic`) that checks restore entrypoint wiring, startup command planning, and startup registration-state inspection without requiring reboot simulation.
- Added Wave 2 startup operator guidance in README for enable/status/disable workflow and explicit restore interaction boundaries.
- Documented Wave 2 startup Rule/Pattern/Failure Mode in scope docs to keep machine-integration verification deterministic and trustable.

## 2026-03-25

- Fixed runtime smoke restart verification to poll canonical `.lifeline/state.json` restart telemetry instead of relying on formatted status text parsing.
- Added deterministic managed-child failure checks in smoke (`/crash`) so `restartCount` progression is observed from the same source the supervisor mutates.
- WHY: smoke could miss real restart bookkeeping when status output lagged or represented non-canonical process metadata.
