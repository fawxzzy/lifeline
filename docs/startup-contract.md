# Startup contract (merged Wave 2)

Merged Wave 2 defines Lifeline's startup-registration seam and deterministic CLI/state behavior. This document tracks the contract boundary and current runtime behavior, including current Windows Task Scheduler support, Linux user-systemd support, macOS launchd support, FreeBSD rc.d support, OpenBSD rcctl support, NetBSD rc.d support, AIX inittab support, and unsupported-platform fallback behavior.

## Scope

- Startup registration scope is **machine-local**.
- The contract target is always the Lifeline restore entrypoint: `lifeline restore`.
- The contract is platform-neutral and does not expose Task Scheduler/systemd/launchd specifics to callers.

## CLI surface

```bash
lifeline startup status
lifeline startup enable [--dry-run]
lifeline startup disable [--dry-run]
lifeline restore [--startup]
```

Semantics:

- `enable`: call the startup backend seam `install` operation, then persist startup intent as `enabled`.
- `disable`: call the startup backend seam `uninstall` operation, then persist startup intent as `disabled`.
- `status`: report current contract state and backend readiness from the active backend seam inspection.
- `--dry-run`: print the plan without writing state or invoking backend install/uninstall mutations.

The contract's canonical startup target is always `lifeline restore`; startup backends must reuse this entrypoint and must not introduce duplicate lifecycle logic.

`restore --startup` is the bounded startup-registration mode. It preserves ordinary restore behavior while allowing a registered startup action to revive persisted `stopped` apps that are still marked restorable. It never revives non-restorable, blocked, or crash-loop apps. The startup action remains alive while its restored supervisors run so an operating-system launcher cannot close the restored process tree when the initial restore dispatch returns.

Status output shape (deterministic):

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

## Contract-only vs real backend status

Current runtime selection supports both real platform installers and contract-only fallback:

- the CLI and persisted startup metadata are real and deterministic
- backend seam calls are real (`install`, `uninstall`, `inspect`)
- the selected backend may be platform-specific (`windows-task-scheduler`) or `unsupported`

Contract behavior split:

- `startup enable`/`startup disable` always call backend seam install/uninstall before persisting intent.
- `startup status` always reports the active seam `inspect` view plus persisted intent.
- `enable --dry-run` / `disable --dry-run` execute planning only and remain non-mutating.
- dry-run planning reports the same canonical restore entrypoint (`lifeline restore`) and backend status/detail shape as mutation flows.

When the selected backend is unsupported, backend readiness resolves as `unsupported` and `.lifeline/startup.json` persists that seam result after non-dry-run `enable` and `disable`.

Once a platform backend lands, this document and deterministic startup verification must be updated in the same change set to keep behavior discoverable.

## Default backend registry coverage (current)

`src/core/startup-backend.ts` exactly registers the following startup backends:

- `aix` → `aix-inittab`
- `darwin` → `launchd-agent`
- `freebsd` → `freebsd-rc.d`
- `linux` → `systemd-user`
- `netbsd` → `netbsd-rc.d`
- `openbsd` → `openbsd-rcctl`
- `win32` → `windows-task-scheduler`

Shipped startup backend platform set is exactly `aix`, `darwin`, `freebsd`, `linux`, `netbsd`, `openbsd`, and `win32`.
Any non-registered platform resolves to the explicit `unsupported` contract-only fallback backend.

## Windows backend status (current)

Default `win32` backend resolution selects the `windows-task-scheduler` backend in normal CLI flow.

Behavior:

- `startup enable` uses the single stable task identity `LifelineRestoreAtLogon` and registers an exact Task Scheduler XML definition only for the current user at logon.
- The task contains exactly one logon trigger and one `Principal id="Author"` for the current identity. Interactive-token and least-privilege defaults may be omitted only when Task Scheduler canonicalizes those declared defaults; extra trigger/principal containers, children, or attributes are conflicts. The task is enabled and demand-startable, and `IgnoreNew` prevents overlapping instances. Current v4 acceptance requires structural equality with the generated Settings block: exact known children and values, no behavioral extras or attributes, and only harmless order/formatting variation.
- The action executes the active Node binary plus a byte-verified, content-addressed Lifeline `dist` snapshot beneath `<runtime-home>/.lifeline/startup/windows/`, passes `--root <runtime-home>` explicitly, sets the working directory to that runtime home, and invokes `restore --startup`. Non-dry-run re-enable verifies the full expected file set and bytes, repairing a corrupt snapshot without trusting metadata alone. Cross-process materialization builds a unique staging directory, rehashes its canonical payload against the previously planned content address, writes metadata last, then uses a bounded filesystem lease and atomic directory publication; a losing publisher accepts only an exact winner. Invalid canonical snapshots are quarantined before replacement, dead publisher leases are recoverable, and partial or plan-mismatched staging content is never treated as canonical or valid. A runtime root equal to or beneath the source `dist`, or any exact launcher source/destination overlap, is rejected before hashing/copying to prevent recursive self-copy.
- An exact repeated enable is a no-op. Concurrent enables each pass a closed, invocation-unique exact XML file to Task Scheduler and converge idempotently: after both inspect an absent task, a losing create accepts an exact current-v4 readback as installed and never deletes it; a missing readback is a verified failure, while any non-exact, conflicting, or unreadable readback is preserved and fails closed because transaction ownership is not proven. Owned-definition rollback uses a separate invocation-unique XML file. Enable may reconcile a Lifeline-owned same-root drifted or legacy v2/v3 definition to v4, but rejects any foreign or conflicting same-name task without overwrite.
- `startup enable` may upgrade a recognized prior Lifeline definition only when its stable URI/author, single current-user trigger/principal (SID or Scheduler-canonicalized account), canonical root, and exactly one versioned stable `Exec` action all match the ownership contract. A second trigger, principal, or action is foreign and blocks overwrite/removal; safe settings drift repairs to the exact v4 structure. Every failed create or failed readback queries the exact task identity. An owned-drift create failure accepts an exact current-v4 concurrent winner, reports exact prior XML as unchanged failure, and preserves missing, different, foreign, or ambiguous readback without stale rollback authority. Only a successful owned scheduler mutation followed by verified absence may restore and verify the exact prior XML through a separate invocation-owned definition. An unverifiable transaction is a blocker, and any observed task reports physically installed. `startup disable` uses the same ownership proof and persists disabled intent only after post-delete query proves absence.
- `startup enable --dry-run` reports recognized owned drift as the same actionable v4 reconciliation that non-dry-run enable would perform, without writing the launcher or task; only foreign/conflicting definitions report blocked.
- `startup status` inspects the same task via `schtasks /Query ...` and reports `windows-task-scheduler` mechanism plus the exact root/action detail.
- Exact-task Scheduler inspection and transaction readback use `schtasks /Query /TN LifelineRestoreAtLogon /XML`; the optional `ONE` XML type token is intentionally omitted for documented cross-version portability.
- The startup restore action remains as a wrapper while restored supervisors are alive and continuously correlates each app's persisted state with the exact launched supervisor PID. If a later app fails to launch after earlier successes, or any held app first becomes blocked, crash-loop, unhealthy, missing, mismatched, or stale-running with a dead supervisor, Lifeline cleans only supervisors started by that invocation before returning failure. Same-identity apps use graceful down and require fresh same-PID `stopped` state. The expected supervisor comparison and stopped/blocked transition are one conditional operation beneath the runtime state store's cross-process mutation lease; a replacement that wins first cannot be overwritten. After persisted identity changes, cleanup refuses app-name down or terminal-state writes, proves the captured original PID dead, and re-verifies the newer replacement identity without stopping or overwriting it. Clean all-running hold remains active; `lifeline down <app>` writes the accepted cleared terminal state, after which an all-stopped invocation exits successfully and Task Scheduler returns to Ready.
- Successful same-PID down clears transient `blockedReason` and `crashLoopDetected` markers together with live process identities before cleanup accepts fresh `stopped` state. Failed/blocked down retains its failure markers; restart counts, timestamps, exit evidence, and other historical fields remain intact.
- A surviving stable launcher snapshot may itself run startup enable/repair. Its `launcher.json` is reserved generated metadata, validated separately, and excluded symmetrically from payload hashing, copying, and source/destination byte-set comparison. A valid exact snapshot reuses itself without recursive copy; a mismatched active-source snapshot fails closed instead of repairing from itself.
- If Task Scheduler CLI is unavailable, backend detail is explicit and readiness resolves to `unsupported`.
- Scheduler availability is queried before current-user identity or launcher-path resolution, so injected unavailable/off-Windows runners preserve the unsupported seam without requiring `whoami.exe`.


## Linux backend status (current)

Default `linux` backend resolution selects the `systemd-user` backend in normal CLI flow.

Behavior:

- `startup enable` writes `~/.config/systemd/user/lifeline-restore.service`, reloads the user manager, and enables/starts the unit for `lifeline restore`.
- `startup disable` disables/stops `lifeline-restore.service`, removes that unit file, and reloads the user manager.
- `startup status` inspects the same user unit via `systemctl --user cat lifeline-restore.service` and reports `systemd-user` mechanism.
- If `systemctl` is unavailable for the user session, backend detail is explicit and readiness resolves to `unsupported`.

## macOS backend status (current)

Default `darwin` backend resolution selects the `launchd-agent` backend in normal CLI flow.

Behavior:

- `startup enable` writes `~/Library/LaunchAgents/io.lifeline.restore.plist` and bootstraps it in the current user domain (`gui/<uid>`) for `lifeline restore`.
- `startup disable` boots out `io.lifeline.restore` from the same user domain and removes that LaunchAgent plist.
- `startup status` verifies canonical `lifeline restore` ProgramArguments from that plist and inspects `launchctl print gui/<uid>/io.lifeline.restore` to report install state via `launchd-agent` mechanism.
- If `launchctl` is unavailable, backend detail is explicit and readiness resolves to `unsupported`.

## FreeBSD backend status (current)

Default `freebsd` backend resolution selects the `freebsd-rc.d` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/usr/local/etc/rc.d/lifeline_restore`, sets executable permissions, and writes `/etc/rc.conf.d/lifeline_restore` with `lifeline_restore_enable="YES"` so startup targets `lifeline restore`.
- `startup disable` removes `/usr/local/etc/rc.d/lifeline_restore` and `/etc/rc.conf.d/lifeline_restore`.
- `startup status` inspects those same files to verify canonical `lifeline restore` wiring and reports install state via `freebsd-rc.d` mechanism.
- Install/uninstall may fail without write access to system startup paths; backend detail remains explicit when that occurs.

## OpenBSD backend status (current)

Default `openbsd` backend resolution selects the `openbsd-rcctl` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/etc/rc.d/lifeline_restore`, sets executable permissions, runs `rcctl set lifeline_restore flags restore`, and enables `lifeline_restore` so startup targets `lifeline restore`.
- `startup disable` disables `lifeline_restore`, clears its rcctl startup flags, and removes `/etc/rc.d/lifeline_restore`.
- `startup status` verifies canonical `lifeline restore` script wiring and inspects `rcctl get lifeline_restore status/flags` to report install state via `openbsd-rcctl` mechanism.
- If `rcctl` is unavailable, backend detail is explicit and readiness resolves to `unsupported`.

## NetBSD backend status (current)

Default `netbsd` backend resolution selects the `netbsd-rc.d` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/etc/rc.d/lifeline_restore`, sets executable permissions, and writes `/etc/rc.conf.d/lifeline_restore` with `lifeline_restore="YES"` so startup targets `lifeline restore`.
- `startup disable` removes `/etc/rc.d/lifeline_restore` and `/etc/rc.conf.d/lifeline_restore`.
- `startup status` inspects those same files to verify canonical `lifeline restore` wiring and reports install state via `netbsd-rc.d` mechanism.
- Install/uninstall may fail without write access to system startup paths; backend detail remains explicit when that occurs.

## AIX backend status (current)

Default `aix` backend resolution selects the `aix-inittab` backend in normal CLI flow.

Behavior:

- `startup enable` creates or updates AIX inittab entry `llrestore` using `mkitab`/`chitab` so startup targets `lifeline restore`.
- `startup disable` removes the same inittab entry with `rmitab`.
- `startup status` inspects the same entry via `lsitab llrestore` and reports install state via `aix-inittab` mechanism when canonical restore wiring is present.
- If AIX inittab tooling is unavailable, backend detail is explicit and readiness resolves to `unsupported`.
- Install/uninstall are machine-local system mutations and may require elevated privileges to write `/etc/inittab`; dry-run remains non-mutating and reports the same planned inittab action.

## Unsupported platform behavior (current)

Platforms without a registered installer backend currently resolve to the `unsupported` backend (for example, `sunos`):

- mechanism is `contract-only`
- status is `unsupported`
- detail includes the concrete platform name (for example, `No startup installer backend is available on sunos yet.`)
- startup intent still persists in `.lifeline/startup.json` for future backend availability

## Restore entrypoint wiring

The canonical startup target remains `lifeline restore`. Startup backends must route to this entrypoint and must not introduce duplicate restore/bootstrap lifecycle entrypoints.

## Persisted metadata

Lifeline persists only minimal Wave 2 metadata in `.lifeline/startup.json`:

- contract `version`
- startup `scope` (`machine-local`)
- `restoreEntrypoint` (`lifeline restore`)
- desired `intent` (`enabled` or `disabled`)
- `backendStatus` readiness marker (`installed` | `not-installed` | `unsupported`)
- `updatedAt` timestamp

No platform-specific registration identifiers are persisted in this slice.

## Backend contract expectation

Future platform installers must plug into this contract, not bypass it. Backends should read the contract intent and apply OS-specific wiring while preserving the contract's machine-local scope and restore-entrypoint target.

Current shipped installer coverage is `win32` via Task Scheduler, `linux` via user systemd, `darwin` via launchd, `freebsd` via rc.d, `openbsd` via rcctl, `netbsd` via rc.d, and `aix` via inittab; remaining startup installers for unregistered platforms.
