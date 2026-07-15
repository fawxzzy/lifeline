# Testing model

Lifeline uses two execution patterns so verification stays deterministic and discoverable from the repository:

- **Targeted runners** for focused debugging and repro.
- **Suite runners** for grouped verification and CI-style execution.

## Deterministic tests

Registry source of truth: `scripts/test-suites.json`.
Runner entrypoint: `scripts/test-runner.mjs`.

### Targeted deterministic script run

Run one deterministic script directly when you are debugging a single failure path:

```bash
node scripts/test-resolve-config-deterministic.mjs

# runtime-home placement, inheritance, and source-checkout isolation
pnpm test:lifeline-root
```

### Grouped deterministic suite run

Use the deterministic suite runner for grouped execution:

```bash
# list deterministic suites
node scripts/test-runner.mjs list

# run one deterministic suite
node scripts/test-runner.mjs core

# run every deterministic suite
node scripts/test-runner.mjs all
```

Current deterministic suites in the registry:

- `commands`
- `contracts`
- `core`
- `examples`
- `utilities`

## Smoke tests

Registry source of truth: `scripts/smoke-suites.json`.
Runner entrypoints:

- Targeted smoke runner: `scripts/smoke-runner.mjs`
- Grouped smoke suite runner: `scripts/smoke-suite-runner.mjs`

### Targeted smoke scenario run

Use the targeted smoke runner for one scenario:

```bash
node scripts/smoke-runner.mjs runtime restore-invalid-manifest-shape
```

### Grouped smoke suite run

Use the smoke suite runner for grouped scenarios:

```bash
# list smoke suites
node scripts/smoke-suite-runner.mjs list

# run one smoke suite
node scripts/smoke-suite-runner.mjs runtime

# run every smoke suite
node scripts/smoke-suite-runner.mjs all
```

Current smoke suites in the registry:

- `playbook`
- `runtime`

## Quick rule of thumb

- **Use targeted runners** (`test-*.mjs` directly, `smoke-runner.mjs`) for debugging and narrow repro.
- **Use suite runners** (`test-runner.mjs`, `smoke-suite-runner.mjs`) for grouped verification before merge and CI parity.
