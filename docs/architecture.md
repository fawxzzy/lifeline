# Architecture

Lifeline uses a small operator architecture with explicit preflight, validation, runtime, and receipt boundaries.

## 1. Manifest contract

The manifest contract is the source of truth for how a Lifeline-managed app should be described. It captures repo location, branch, commands, port, healthcheck, environment expectations, deployment strategy, and runtime restart/restore policy.

Manifest validation can stay structural in manifest-only mode. When a Playbook path is provided, Lifeline resolves a final config first and validates the resolved result instead.

## 2. Optional Playbook export surface

Playbook is one repo with two roles:

- a human-facing local UI/workflow for operators
- a machine-readable Lifeline export surface at `<playbook-path>/exports/lifeline/`

Lifeline only consumes Playbook export files from disk. There are no HTTP calls, no requirement that the Playbook UI be running, and no runtime dependency on an external service.

## 3. Shared preflight + hermetic validate boundary

The preflight contract is the environment gate in front of manifest validation:

- `doctor` runs the shared preflight contract and prints the operator-facing success or failure surface without reading a manifest
- `validate` runs the same preflight contract before it loads a manifest or resolves Playbook defaults
- preflight failures stay short and actionable: category plus first remediation step
- preflight currently covers Node engine range, package-manager contract, shell-runtime probes, and repo prerequisites such as the lockfile
- the standalone `scripts/validate-fitness-mirror.mjs` helper delegates back to `lifeline validate` so mirror validation stays on the same CLI boundary instead of importing temp-transpiled outputs directly

This is the hermetic validation rule for the repo:

- Rule: validation must execute through the same boundary operators use for real runtime-facing work.
- Pattern: inspect the environment first, then validate the resolved or raw manifest through the CLI.
- Failure Mode: helper-only temp transpile paths can create fake Windows/Node module-boundary failures that do not exist on the real Lifeline path.

## 4. CLI operator

The CLI is the operator-facing entrypoint. Current commands:

- `doctor`
- `validate`
- `resolve`
- `up`
- `down`
- `status`
- `logs`
- `restart`
- `restore`
- `startup` (merged Wave 2 backend seam with registered platform installers)
- `release`
- `execute`
- `proof-pass`

`up` resolves config and runs install/build, then launches a detached Lifeline supervisor process (not the app process directly).

Before dispatch, the CLI resolves the Lifeline runtime home with `--root` taking precedence over `LIFELINE_ROOT`, which takes precedence over the invoking working directory. The resolved absolute home is exported as `LIFELINE_ROOT` for child and detached supervisor inheritance. This selection only relocates mutable `.lifeline` state; it does not call `chdir`, replace application working directories, or redirect Atlas discovery and repository path semantics. `doctor` reports the home and state directory without creating them.

## 5. Local runtime layer + startup contract surface (Wave 1 + merged Wave 2)

Runtime behavior:

- one supervisor process per app
- supervisor owns and monitors the child app process
- restart policy support: `runtime.restartPolicy` (`on-failure` or `never`)
- bounded restart backoff with crash-loop cutoff
- persisted runtime metadata in `<resolved-home>/.lifeline/state.json` (supervisor pid, child pid, restart counters, last exit)
- `restore` reads persisted state and re-launches restorable supervisors idempotently
- startup contract is configured via `startup`, with canonical restore wiring to `lifeline restore` and deterministic install/uninstall/inspect behavior through the startup backend seam
- cross-platform stop behavior: `taskkill /T /F` on Windows, process-group termination on POSIX

Logs remain file-based at `<resolved-home>/.lifeline/logs/<app>.log` and include both app output and supervisor lifecycle events.

## 6. Wave 1 release target surface

Wave 1 release planning and activation stay local-first:

- the deploy contract normalizes `artifactRef`, `imageRef`, and branch-shaped `repo` + `branch` inputs into one canonical release target
- release ids are deterministic from the normalized release target unless an operator pins a specific id
- immutable release metadata lands at `<resolved-home>/.lifeline/releases/<app>/<releaseId>/metadata.json`
- mutable activation state is limited to `current.json` and `previous.json`
- activation is health-gated, and failed candidates must not disturb the last known-good release pointers
- plan, activation, failed activation, and rollback each emit receipts keyed to concrete release ids

This is the first execution slice that replaces "deploy a branch" with "deploy a concrete release target" without introducing hosted control-plane behavior.

The operator-facing release CLI stays narrow:

- `lifeline release plan <deploy-manifest>`
- `lifeline release persist <deploy-manifest>`
- `lifeline release activate <app-name> <release-id>`
- `lifeline release rollback <app-name>`

This surface is intentionally local-only. It does not add domain automation, TLS automation, preview-host assumptions, hosted control-plane behavior, or app-specific special casing.

## 7. Receipt-backed execution and proof surfaces

Lifeline exposes two narrow auditable lanes after validation/runtime work:

- `execute` is the capability-backed, approval-backed execution lane for bounded read-only inspection and dry-run commands
- `proof-pass` is the proof-backed completion lane for emitting `proof_passed` receipts from already-derived ATLAS proof summaries
- request, approval, proof summary, and capability inputs are loaded from local files
- blocked, rejected, and expired execution attempts still emit an execution receipt
- proof-backed completion emits a receipt only when the referenced ATLAS summary is clean and `completion_ready=true`
- receipt ids are derived from governed inputs instead of wall-clock time
- receipt refs normalize path-like values to forward slashes before write so Windows and POSIX output stays diffable
- operator-facing receipt failures print a category plus the first remediation step
- worker-originated requests may carry `source_refs` to `_stack` assignment, status, merge, or handoff artifacts, and Lifeline preserves those refs in the receipt trail

These surfaces are intentionally not ambient admin. They are receipt-backed lanes for bounded execution and proof-backed completion only.

## Startup backend boundary

The merged Wave 2 contract provides startup intent/state plus registered machine-local installers behind one seam:

- `win32` -> Task Scheduler (`windows-task-scheduler`)
- `linux` -> user systemd (`systemd-user`)
- `darwin` -> launchd LaunchAgent (`launchd-agent`)
- `freebsd` -> rc.d (`freebsd-rc.d`)
- `openbsd` -> rcctl (`openbsd-rcctl`)
- `netbsd` -> rc.d (`netbsd-rc.d`)
- `aix` -> inittab (`aix-inittab`)

All startup backends keep `lifeline restore` as the canonical restore entrypoint target and preserve `--dry-run` non-mutation semantics through the same seam. Unregistered platforms still resolve to the explicit `unsupported` contract-only fallback backend.
