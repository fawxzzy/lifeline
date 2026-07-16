# Lifeline

Lifeline is the opinionated, self-hosted local operator for manifest-defined apps. This repository is intentionally narrow: Lifeline v1 validates manifests, resolves optional Playbook defaults from disk, runs one stable local or staging-style instance on one machine, and includes the merged Wave 2 startup contract surface for deterministic `lifeline restore` startup intent management.

## Wave 1 runtime foundation

The repository now also carries the Wave 1 single-host runtime foundation under `infra/` and `runtime/`.

- `infra/compose.yaml` defines the two-service host boundary: a pilot app on port `3000` and a Caddy reverse proxy on `8080`/`8443`.
- `runtime/wave-1/pilot/` contains the minimal pilot app image and env contract.
- `docs/architecture/wave-1-runtime-foundation.md` records the host contract, storage assumptions, and non-goals.

## Role in the stack

Lifeline is the execution-oriented local operator in the broader Fawxzzy stack.

- Atlas is the stack coordination layer and policy surface.
- Playbook is the human-facing workflow and export producer.
- Fitness is a representative application surface that Lifeline can validate, resolve, and run through its manifest contract.

Lifeline stays intentionally narrower than the rest of the stack: it consumes checked-in config, executes governed local operations, and emits explicit runtime state and receipts. It does not own portfolio orchestration, hosted control planes, or ambient admin UX.

## Repository status

- Git transport and upstream wiring are complete: `main` tracks `origin/main`.
- The repo is ready for small baseline-governance PRs before further implementation work.
- Current scope remains a local-first CLI/operator, not a hosted platform.
- This baseline pass stays narrow: no control-plane expansion, no multi-host growth, and no ambient admin surface.

## Next milestone

Machine-readable roadmap truth lives in `docs/roadmap/LIFELINE_ROADMAP.json`. The deterministic owner export at `exports/lifeline.project-board.owner-export.v1.json` includes only non-complete work. `.playbook/plan.json` is verification-plan output and is not the Lifeline product roadmap.

The external runtime-home placement contract (`LIF-201`), supervised Playbook Observer restart proof (`LIF-203`), and Windows logon restoration proof (`LIF-204`) are complete. Windows startup now restores a stopped/restorable app through a current-user logon task, an explicit runtime home, and a stable launcher snapshot beneath that runtime home.

`LIF-202` remains a separate intake candidate for a measured unsupported platform. None of these lanes authorizes hosted-platform growth.

## Why Lifeline exists

Lifeline provides a boring, low-maintenance way to describe how an app should be installed, built, started, stopped, checked, and inspected on a self-hosted machine. It is deliberately not a hot-reload workflow replacement and deliberately not a hosted platform clone.

## What Lifeline is

- A single-package TypeScript CLI for a manifest-defined local operator.
- A home for a small, explicit app manifest contract.
- A file-based config resolver that can optionally read Playbook archetype exports from a local checkout.
- A runtime slice that can `resolve`, `up`, `down`, `status`, `logs`, `restart`, `restore`, `startup`, and `validate` one app on one machine.
- A local-first Wave 1 release surface that can `release plan`, `release persist`, `release activate`, and `release rollback` against the existing deploy manifest contract.
- A narrow capability-backed execution surface that can `execute` read-only inspections and dry-run commands with receipts.
- A narrow proof-backed receipt surface that can emit auditable `proof_passed` receipts from ATLAS UI proof summaries.
- Fixture-based smoke paths that verify manifest-only runtime behavior and Playbook-backed resolution without depending on an external Playbook repo.

## What Lifeline is not

- Not a cloud platform.
- Not a dashboard.
- Not an auth system.
- Not a database-backed control plane.
- Not a multi-node orchestrator.
- Not a hot reload replacement.
- Not repo clone/pull, webhook, proxy, or domain automation.
- Not coupled to a running Playbook process, service, or UI.

## Current v1 commands

```bash
pnpm install
pnpm build
pnpm lifeline doctor
pnpm lifeline validate examples/fitness-app.lifeline.yml
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline validate fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline up fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml
pnpm lifeline up fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline status runtime-smoke-app
pnpm lifeline logs runtime-smoke-app
pnpm lifeline restart runtime-smoke-app
pnpm lifeline restore
pnpm lifeline startup status
pnpm lifeline startup enable
pnpm lifeline startup disable
pnpm lifeline release plan control-plane/fixtures/wave1-pilot-deploy.manifest.json
pnpm lifeline release persist control-plane/fixtures/wave1-pilot-deploy.manifest.json
pnpm lifeline release activate lifeline-pilot <release-id>
pnpm lifeline release rollback lifeline-pilot
pnpm lifeline execute examples/privileged-execution/read-only-scan.request.json \
  --capability-profile examples/privileged-execution/capability-profile.json \
  --approval-receipt examples/privileged-execution/read-only-scan.approval.json
pnpm lifeline proof-pass ../../runtime/atlas/ui-proof/fitness/latest.json \
  --source-repo fitness \
  --tranche F11
pnpm lifeline down runtime-smoke-app
```

## Runtime home placement

Lifeline resolves one runtime home before command dispatch and stores mutable operator state beneath `<resolved-home>/.lifeline/`. Select it with either global CLI form, `--root <path>` or `--root=<path>`, or with `LIFELINE_ROOT`. Precedence is CLI `--root`, then `LIFELINE_ROOT`, then the invoking process working directory. Relative CLI or environment values resolve from that invoking working directory, and the resolved absolute value is written back to `LIFELINE_ROOT` so detached supervisors inherit it.

The runtime-home option does not change the process working directory, application working directories, manifest or Playbook path resolution, Atlas discovery, or unrelated repository semantics. Existing `--receipt-dir` options remain the more-specific receipt destination override.

`pnpm lifeline doctor --root <path>` reports the resolved home and `<resolved-home>/.lifeline` state directory without creating either path.

Proof-pass receipt refs normalize path-like values to forward slashes, and `proof-pass` prints a failure category plus a first remediation step when emission fails.

Worker-originated requests can add `source_refs` for `_stack` assignment, status, merge, or handoff artifacts. Lifeline preserves those refs in the emitted receipt so the execution trail stays anchored to worker context instead of hidden transcripts.

## Intended operator flow

Use the operator path in this order so environment drift, manifest drift, and receipt emission stay explicit:

1. `pnpm lifeline doctor`
2. `pnpm lifeline validate <manifest> [--playbook-path <path>]`
3. the intended runtime action (`up`, `restart`, `status`, or `execute`)
4. the auditable receipt step (`execute` writes an execution receipt for every attempt; `proof-pass` writes a deterministic `proof_passed` receipt when the referenced ATLAS summary is clean and `completion_ready=true`)
5. when release state must move, use the bounded release lane (`release plan`, `release persist`, `release activate`, `release rollback`) against the existing deploy manifest contract

- Rule: validation must execute through the same CLI boundary operators use for real runtime-facing work.
- Pattern: run the shared preflight first, validate through the canonical CLI boundary second, then emit deterministic receipts with an explicit first remediation step when receipt emission is blocked.
- Failure Mode: temp-transpiled helper paths and late environment discovery create noisy module-boundary failures that do not describe the real operator path.

## Optional Playbook integration

Playbook is treated as one repo with two separate roles:

- a human-facing local UI/workflow for operators
- a machine-readable export surface for Lifeline at `<playbook-path>/exports/lifeline/`

Lifeline only consumes the checked-in export files from disk. It does not call a Playbook HTTP API, does not require Playbook to be running, and still works fully in manifest-only mode.

### Playbook path precedence

1. `--playbook-path <path>`
2. `LIFELINE_PLAYBOOK_PATH`
3. no Playbook path, which means manifest-only mode

If a Playbook path is supplied but invalid, Lifeline fails clearly before runtime execution.

### Playbook export metadata contract

Lifeline reads `<playbook-path>/exports/lifeline/schema-version.json` and accepts:

- canonical/current contract: `{ "schemaVersion": <number|string>, "exportFamily": "lifeline-archetypes" }`
- legacy compatibility: `{ "version": <number> }`

Behavior is explicit:

- `schemaVersion` takes precedence over `version` when both are present
- `exportFamily` accepts `lifeline-archetypes` (canonical) and `lifeline` (legacy compatibility), and Lifeline normalizes internally to `lifeline-archetypes`
- missing schema version fields fail clearly
- unsupported schema versions fail clearly

### Merge precedence

Resolution is intentionally small and explicit:

1. start from Playbook archetype defaults when a Playbook path is available
2. apply manifest values on top
3. explicit manifest values always win

Lifeline only merges known top-level manifest fields plus the nested `env`, `deploy`, and `runtime` sections. It does not perform arbitrary deep-merge magic.
Playbook archetype exports are sparse optional default bundles. They may omit any app-default field (`installCommand`, `buildCommand`, `startCommand`, `healthcheckPath`, `env`, `deploy`, `port`), and missing runtime requirements must then come from explicit manifest values.

## Validation and resolution behavior

- `lifeline doctor` runs the shared preflight contract that validation uses before it reads manifests.
- `lifeline doctor` is the explicit way to inspect the same environment boundary that `lifeline validate` will enforce.
- `lifeline validate <manifest>` validates the raw manifest structure only.
- `lifeline validate` fails fast on Node, package-manager, shell, or repo prerequisite mismatches before manifest validation starts.
- `lifeline validate <manifest> --playbook-path <path>` validates the resolved config, so required runtime fields may come from Playbook defaults.
- Lifeline treats Playbook archetypes as optional default bundles and validates only fields that are present in those exports.
- Lifeline enforces runnable requirements only on the final resolved config after defaults+manifest merge.
- The runtime `port` requirement can come from either Playbook defaults or explicit manifest values.
- `lifeline resolve <manifest>` prints the fully resolved config that Lifeline would execute.
- `lifeline up` and `lifeline restart` use the same resolution path as `resolve`.
- `lifeline release plan <deploy-manifest>` previews the normalized release metadata, deterministic release id, and local `.lifeline/releases/<app>/...` layout without writing state.
- `lifeline release persist <deploy-manifest>` writes immutable release metadata plus a planned receipt under `.lifeline/releases/<app>/receipts/`.
- `lifeline release activate <app> <release-id>` promotes one persisted release id to current and records activation lineage locally.
- `lifeline release rollback <app>` promotes the previous known-good release back to current and emits a rollback receipt.
- The standalone `scripts/validate-fitness-mirror.mjs` helper delegates to `lifeline validate` so mirror validation uses the same CLI boundary as normal runtime-facing validation paths instead of importing temp-transpiled outputs.
- If an app was started with Playbook defaults, Lifeline stores the resolved Playbook path in `.lifeline/state.json` so `restart` remains deterministic without retyping flags.

## Preflight troubleshooting

If `lifeline validate` fails before manifest parsing, run `pnpm lifeline doctor` first. The shared preflight contract reports the first actionable remediation for:

- Node version mismatches against the repository engine range
- package-manager drift from the `packageManager` contract
- shell/runtime probe failures
- missing repository prerequisites such as the lockfile

The failure surface is intentionally short: category plus first remediation step should fit in one screen.

Windows/Node troubleshooting notes:

- Treat helper-vs-CLI validation differences as boundary bugs. Use `pnpm lifeline validate` or `node scripts/validate-fitness-mirror.mjs` as the canonical path.
- Do not treat temp-transpiled `.js` outputs in typeless temp roots as canonical evidence on Windows. Those paths can trigger Node 22 module-format drift that does not exist in the real Lifeline runtime boundary.
- If preflight fails, fix that environment issue before chasing manifest errors. Late environment discovery makes validation noisy and hides the actual root cause.

## Runtime behavior

`lifeline up <manifest-path>` performs the local runtime lifecycle:

- loads the manifest
- optionally loads Playbook archetype defaults from disk
- resolves config before validation and execution
- resolves `deploy.workingDirectory` relative to the manifest file
- loads `env.file` if present
- overlays `process.env` on top of env-file values
- normalizes missing `env.requiredKeys` to `[]`
- validates provided `env.requiredKeys` entries
- runs `installCommand`
- runs `buildCommand`
- starts a detached Lifeline supervisor for the app
- supervisor starts `startCommand`, watches exits, and restarts on failures with bounded backoff
- appends app output and supervisor lifecycle events to `.lifeline/logs/<app-name>.log`
- stores supervisor pid, wrapper child pid, and tracked listener pid/port ownership metadata in `.lifeline/state.json`
- polls `http://127.0.0.1:<port><healthcheckPath>` for a simple health check and reports blocked/unhealthy states when restart cannot reclaim the managed port
- `lifeline down` reclaims the real managed listener and waits for managed port release before reporting success
- supports `lifeline restore` to restart restorable apps from persisted state


## Startup registration contract (Wave 2)

Lifeline Wave 2 introduces a platform-neutral startup registration contract for machine-local auto-start of the `lifeline restore` flow.

Commands:

```bash
pnpm lifeline startup status
pnpm lifeline startup enable
pnpm lifeline startup disable
pnpm lifeline startup enable --dry-run
pnpm lifeline startup disable --dry-run
```

Current merged Wave 2 startup-contract behavior:

- `startup enable` calls backend seam `install` and persists intent to enabled in `.lifeline/startup.json`.
- `startup disable` calls backend seam `uninstall` and persists intent to disabled in `.lifeline/startup.json`.
- `startup status` reports support, enabled intent, backend install status, scope, canonical restore entrypoint (`lifeline restore`), mechanism, and backend detail from seam inspection.
- `--dry-run` prints the planned startup action without mutating `.lifeline/startup.json` or performing backend install/uninstall writes.
- Windows enable dry-run reports recognized same-root owned drift as an actionable v4 reconciliation plan; foreign/conflicting definitions remain blocked.
- Current Windows (`win32`) behavior uses a real Task Scheduler backend (`windows-task-scheduler`) in default CLI backend selection.
- Windows registration uses the single stable task identity `LifelineRestoreAtLogon`, a current-user logon trigger/principal, limited run level, exactly one Lifeline `Exec` action, `IgnoreNew`, and the complete battery/idle/demand-start/time-limit reliability settings contract.
- The Windows task action runs a byte-verified, content-addressed Lifeline `dist` snapshot beneath `<runtime-home>/.lifeline/startup/windows/`, passes the runtime home explicitly with `--root`, and never depends on the enabling source worktree after registration. Re-enable repairs corrupt or incomplete snapshot contents even when launcher metadata still claims the expected hash. Roots equal to or nested beneath the active `dist` source, and any other source/destination overlap, fail before hashing or copying.
- Windows enable is idempotent for an exact v4 definition, upgrades only recognized prior Lifeline definitions with the stable URI/author, exactly one same-current-user logon trigger/principal, canonical root, and one expected stable action, and rejects extra triggers/principals, a different user/root, or a foreign/multi-action same-name task without overwrite. Safe owned settings drift—including unknown extra settings—is repaired to the structurally exact contract. Create failures and failed readback are queried and transactionally reconciled: an absent pre-state must remain or become verified absent, while an owned upgrade must retain or restore its exact prior XML and report that registration as still physically installed. Disable persists disabled intent only after an exact post-delete query proves absence.
- The task uses `lifeline restore --startup`: ordinary `lifeline restore` still skips intentionally stopped apps, while startup mode may revive a stopped app only when it remains `restorable: true`. The startup wrapper correlates every restored supervisor with its persisted identity while holding the process tree. A partial multi-app launch failure or the first blocked, crash-loop, unhealthy, missing, mismatched, or stale-dead supervisor state cleans every supervisor started by that invocation and verifies fresh `stopped` terminal state before failing. Clean `lifeline down` establishes that terminal state and lets the wrapper exit successfully.
- Current Linux (`linux`) behavior uses a real user-systemd backend (`systemd-user`) in default CLI backend selection.
- Current macOS (`darwin`) behavior uses a real launchd LaunchAgent backend (`launchd-agent`) in default CLI backend selection.
- Current FreeBSD (`freebsd`) behavior uses a real rc.d backend (`freebsd-rc.d`) that installs `lifeline_restore` and enables it via `/etc/rc.conf.d/lifeline_restore`.
- Current OpenBSD (`openbsd`) behavior uses a real rcctl backend (`openbsd-rcctl`) that writes `/etc/rc.d/lifeline_restore`, sets `rcctl` flags to `restore`, and enables `lifeline_restore`.
- Current NetBSD (`netbsd`) behavior uses a real rc.d backend (`netbsd-rc.d`) that writes `/etc/rc.d/lifeline_restore` and enables it via `/etc/rc.conf.d/lifeline_restore`.
- Current AIX (`aix`) behavior uses a real inittab backend (`aix-inittab`) that manages a canonical `llrestore` inittab entry to run `lifeline restore` at startup.
- AIX startup registration assumes `lsitab`/`mkitab`/`chitab`/`rmitab` are available and writable for `/etc/inittab`; when those tools are unavailable or permission is insufficient, status and mutation details remain explicit from the backend seam.

Default startup backend registry coverage in `src/core/startup-backend.ts` is exactly:

- `aix` -> `aix-inittab`
- `darwin` -> `launchd-agent`
- `freebsd` -> `freebsd-rc.d`
- `linux` -> `systemd-user`
- `netbsd` -> `netbsd-rc.d`
- `openbsd` -> `openbsd-rcctl`
- `win32` -> `windows-task-scheduler`

Shipped startup backend platform set is exactly `aix`, `darwin`, `freebsd`, `linux`, `netbsd`, `openbsd`, and `win32`.
Any non-registered platform still resolves through the explicit `unsupported` `contract-only` fallback backend.

When the active backend is unsupported, startup status reports mechanism (`contract-only`) so fallback behavior stays explicit.

Deterministic status output shape:

```text
Startup supported: <yes|no>
Startup enabled: <yes|no>
Startup backend status: <installed|not-installed|unsupported>
- backend: <backend id>
- mechanism: <backend mechanism>
- scope: machine-local
- restore entrypoint: lifeline restore
- detail: <backend/status detail>
```

For unsupported backends, status and mutation detail must remain explicit (for example, `No startup installer backend is available on sunos yet.`) so startup state is not tribal knowledge.

## Slim manifest example with Playbook defaults

This manifest is intentionally incomplete on its own, but becomes runnable when paired with a Playbook export for the `node-web` archetype:

```yaml
name: runtime-smoke-app
archetype: node-web
repo: local-fixture
branch: main
```

Run it with:

```bash
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml \
  --playbook-path fixtures/playbook-export
```

## Runtime state and logs

Lifeline stores its local operator artifacts under `<resolved-home>/.lifeline/`:

- `<resolved-home>/.lifeline/state.json`: explicit runtime state keyed by app name, including stored manifest path, optional stored `playbookPath`, supervisor/child pids, restart metadata, and restore flags
- `<resolved-home>/.lifeline/logs/<app-name>.log`: appended stdout/stderr logs for the managed process
- `<resolved-home>/.lifeline/startup.json`: machine-local startup intent and observed backend status
- `<resolved-home>/.lifeline/releases/`: immutable release metadata, pointers, and release receipts
- `<resolved-home>/.lifeline/receipts/`: privileged execution and proof-passed receipts unless `--receipt-dir` overrides the destination

The default remains the invoking working directory for backward compatibility. An external runtime home keeps machine-local state out of a source checkout.

## Fixture apps and smoke verification

The `fixtures/runtime-smoke-app/` app exists only to verify Lifeline's runtime slice end to end. The `fixtures/playbook-export/` tree mirrors the expected Playbook export layout so CI can verify Playbook-backed resolution without depending on the real external Playbook repo.

Run the smoke paths with:

```bash
node scripts/lib/ensure-built.mjs
pnpm smoke:runtime
pnpm smoke:playbook
pnpm test:startup-deterministic
pnpm test:startup-roundtrip
```

`node scripts/lib/ensure-built.mjs` is the canonical smoke preflight. It fails early with explicit setup errors (missing/stale `dist/cli.js`) so smoke failures that follow are runtime/regression signals.

The canonical repo verification contract is `pnpm run verify`. GitHub Actions enforces that same contract through the required `verify` check on pull requests, while `Playbook Smoke` remains a manual supplemental lane.

### Smoke execution modes

For complete testing execution patterns (targeted vs grouped deterministic and smoke runs), see [docs/testing.md](docs/testing.md).

Use the smoke runners with distinct intent:

- **Single-scenario runs (`scripts/smoke-runner.mjs`)** are for debugging and targeted repro.
- **Suite runs (`scripts/smoke-suite-runner.mjs`)** are for grouped verification before merge/CI parity.

For targeted runtime smoke scenarios, prefer the deterministic single-scenario runner instead of adding new `package.json` script keys:

```bash
pnpm smoke:run runtime restore-invalid-manifest-shape
pnpm smoke:run runtime restart-invalid-playbook-export
```

The single-scenario runner resolves files by `scripts/smoke-<mode>-<scenario>.mjs` naming convention. New runtime smoke coverage should usually be added as a new `scripts/smoke-runtime-<scenario>.mjs` file only.

For grouped smoke verification, use the suite runner:

```bash
node scripts/smoke-suite-runner.mjs list
node scripts/smoke-suite-runner.mjs playbook
node scripts/smoke-suite-runner.mjs runtime
node scripts/smoke-suite-runner.mjs all
```

Available smoke suites are sourced from `scripts/smoke-suites.json`:

- `playbook`: Playbook-backed resolution verification suite.
- `runtime`: Runtime lifecycle and failure-path verification suite.

All smoke scripts invoke the canonical local Lifeline CLI entrypoint (`node dist/cli.js`) and therefore require `pnpm build` beforehand so `dist/cli.js` exists.

## Deterministic suite structure

Testing structure is documented in [`docs/testing.md`](docs/testing.md), with deterministic suites sourced from `scripts/test-suites.json` and executed via `scripts/test-runner.mjs`.

Smoke suites complement (not replace) deterministic test suites:

- Smoke suites (`scripts/smoke-suites.json` + `scripts/smoke-suite-runner.mjs`) group end-to-end CLI behavior checks.
- Deterministic test suites (`scripts/test-suites.json` + `scripts/test-runner.mjs`) group repeatable contract/test coverage.

### Smoke suite docs summary

- **Rule:** Grouped smoke execution should be discoverable from the repository, not tribal knowledge.
- **Pattern:** Use the single-scenario runner for debugging and the suite runner for grouped verification.
- **Failure Mode:** Without docs parity, suites exist but contributors keep relying on brittle one-off smoke commands.

### Directly-invoked helper script contract

- **Rule:** Any new directly-invokable helper script must be added to the deterministic invocation contract in the same PR.
- **Pattern:** Helper-script surface is explicit and fail-closed, not inferred loosely.
- **Failure Mode:** Adding helper scripts without updating invocation-boundary tests causes deterministic CI drift.

## CI toolchain install hardening

- **Rule:** CI test environments must install native optional toolchain packages required by transform-based test runners.
- **Pattern:** If TypeScript build passes but Vitest fails on `@esbuild/linux-x64`, treat it as install/bootstrap drift first.
- **Failure Mode:** Cross-platform cache reuse or optional-dependency suppression can produce false regressions across repos.

CI workflows in this repository enforce `NPM_CONFIG_OPTIONAL=true` and `PNPM_CONFIG_OPTIONAL=true`, run a frozen-lockfile install, and execute `pnpm ci:verify:esbuild` before test-like smoke/deterministic suites.

## Early target manifests

The fitness app and Playbook UI remain early Lifeline targets. Their manifests continue to document the shared contract shape, but actual runtime execution requires a valid local `deploy.workingDirectory` on the machine where Lifeline runs. Their application code does not live in this repository.

`examples/fitness-app.lifeline.yml` is a Lifeline-local mirror of the Fitness-owned manifest contract boundary. Keep its shape aligned to the external `.lifeline/fitness.lifeline.yml` fields Lifeline consumes, and do not independently evolve this mirror as a separate contract.

Rule: Mirrors must not be validated as canonical sources unless they fully satisfy the canonical contract.

Pattern: Separate canonical manifest validation from narrow local mirror validation.

Failure Mode: Partial mirrors routed through canonical validators create misleading missing-field failures.

Troubleshooting: if validation behavior differs between a helper script and `lifeline validate`, treat that as a boundary bug. Validation helpers should delegate to the CLI boundary instead of importing temp-transpiled `.js` outputs directly, because typeless temp roots can trigger Node 22 module-format drift on Windows.

## Minimal dependency policy

Lifeline keeps dependencies intentionally small:

- `typescript`: compile and typecheck the CLI.
- in-repo Node shims: enough type coverage to keep the standard-library operator code buildable during bootstrap.
- `@biomejs/biome`: one tool for formatting and linting.

YAML parsing and env-file parsing are implemented inside the repo because the contracts are small and stable.

## Project documents

- [Scope](docs/scope.md)
- [Architecture](docs/architecture.md)
- [Hermetic validation runbook](docs/runbooks/hermetic-validation-operator-flow.md)
- [Operator surface](docs/ops/lifeline-operator-surface.md)
- [Startup contract (Wave 2)](docs/startup-contract.md)
- [Privileged execution](docs/privileged-execution.md)
- [UI proof-passed receipt contract](docs/contracts/ui-proof-passed-receipt-contract.md)
- [App manifest contract](docs/contracts/app-manifest.md)
- [ADR 0001: Lifeline v1 scope](docs/adr/0001-lifeline-v1-scope.md)



## Wave 2 startup registration operator workflow

Wave 2 adds OS startup registration as a machine-integration layer on top of the existing runtime and restore flow. Keep usage narrow and deterministic:

1. **Enable startup registration** so the OS invokes Lifeline restore on login/boot.
   ```bash
   pnpm lifeline startup enable
   ```
2. **Inspect startup status** to confirm registration target, identity, and restore entrypoint.
   ```bash
   pnpm lifeline startup status
   ```
3. **Disable startup registration** to cleanly remove machine-level wiring when you no longer want automatic restore.
   ```bash
   pnpm lifeline startup disable
   ```

Expected interaction with `restore` stays explicit: startup registration contract intent always targets the same restore entrypoint (`lifeline restore`) that operators run manually. Reboot simulation is optional; deterministic verification should focus on command planning, contract-state inspection, and restore-entrypoint wiring.

**Rule:** Machine-integration features need deterministic verification even when literal reboot simulation is impractical.

**Pattern:** Verify startup command planning, registration state inspection, and restore entrypoint wiring independently from real reboot execution.

**Failure Mode:** Startup ships with hand-wavy docs and no deterministic checks, so registration breaks silently and operators cannot trust it.

## Wave 1 notes

Wave 1 added a supervisor-backed lifecycle plus restore semantics. Wave 2 now includes the startup contract/CLI surface plus default `win32` Task Scheduler, `linux` user-systemd, `darwin` launchd, `freebsd` rc.d, `openbsd` rcctl, `netbsd` rc.d, and `aix` inittab backend wiring; remaining installers for unregistered platforms stay behind the same seam.
