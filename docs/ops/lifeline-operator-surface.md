# Lifeline Operator Surface

This is the minimum operator contract for day-to-day Lifeline usage after the shared preflight and deterministic receipt changes. Use it as the short operator reference for environment checks, validation, runtime visibility, and auditable receipts.

## Intended path

Run the operator flow in this order:

1. `pnpm lifeline doctor`
2. `pnpm lifeline validate <manifest> [--playbook-path <path>]`
3. runtime action (`up`, `restart`, `status`, or `execute`)
4. receipt step (`execute` receipt or `proof-pass` receipt)

Why this order matters:

- `doctor` exposes the same environment boundary `validate` will enforce
- `validate` must stay on the canonical CLI boundary so helper scripts do not drift into temp-transpile behavior
- runtime action should happen only after environment and manifest checks are already clean
- receipts are the audit record of what actually happened, not a side channel

## Validation contract

- `lifeline doctor` is the explicit preflight report for Node, package-manager, shell-runtime, and repo prerequisites.
- `lifeline validate` fails before manifest parsing when that shared preflight contract is not satisfied.
- `scripts/validate-fitness-mirror.mjs` delegates to `lifeline validate`, which keeps mirror validation on the same boundary as normal operator usage.
- If validation differs between a helper and `lifeline validate`, treat that as a boundary bug rather than a manifest bug.

## Log contract

- Managed app output is appended under `.lifeline/logs/<app-name>.log`.
- Each `lifeline up` cycle starts with a header line in the log file.
- `lifeline logs <app-name> [line-count]` tails the log file, with `100` lines as the default.
- When Wave 1 release state exists, `lifeline logs` prints the current and previous release ids before the tailed log lines so incident notes stay bound to a concrete release lineage.
- Log output is line-oriented and stable enough for operators to grep, tail, and attach to incident notes.

Useful signals:

- startup header: `=== lifeline up <timestamp> ===`
- app output: emitted by the managed process itself
- operator fallback: if the log file is missing, `lifeline logs` reports that explicitly

## Health contract

- `lifeline status <app-name>` is the primary health visibility command.
- Healthy state requires the supervisor, the managed child process, port ownership, and a successful health check.
- The status output always reports the local healthcheck URL, last known status, log path, manifest path, restart policy, and crash-loop state.
- When Wave 1 release state exists, `lifeline status` also reports the current release id, previous release id, current artifact ref, rollback target, and recent release receipts.
- `lifeline status <app-name> --proof-text` gives a compact operator brief.
- `lifeline status <app-name> --proof-gate` makes the proof brief fail closed.

Useful signals:

- `App <name> is running.` means the pilot can proceed.
- `- health: ok (200)` means the managed app is answering the healthcheck.
- `- currentReleaseId:` and `- previousReleaseId:` identify the live and rollback-adjacent release lineage.
- `- rollbackTarget.releaseId:` and `- receipt:` lines show the concrete rollback target and recent release receipts.
- `blockedReason` or `- health: managed app process not running` means cutover should stop.

## Receipt contract

- `lifeline execute` writes a receipt for every attempt, including blocked attempts.
- `lifeline proof-pass` writes a deterministic `proof_passed` receipt only when the referenced ATLAS proof summary is clean and `completion_ready=true`.
- Receipt failures print a failure category plus the first remediation step so the operator can stop on the real root cause.
- Path-like refs are normalized before write so receipts stay diffable across Windows and POSIX environments.

## Smoke-check path

Run the disposable smoke check path from the repo root:

```bash
node tests/ops/lifeline-ops-smoke.mjs
```

That smoke path verifies:

- `up` can start the fixture app
- `status` can prove health visibility
- `logs` can surface the startup trail
- `down` can act as the rollback primitive

## Operator decision rule

- Proceed only when `status` reports running and health is `ok (200)`.
- Hold or roll back when `status` reports stopped, blocked, unhealthy, or a port owner that does not match the managed app.
- Use `logs` first when health or restart behavior is unclear.
- Use `doctor` first when `validate` fails before manifest parsing.
- Use the receipt failure category and first remediation step before attempting ad hoc local debugging.
