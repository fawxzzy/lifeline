# QA

This repo owns QA intent only.

- Adapter manifests live under `qa/adapters/`.
- Scenario manifests live under `qa/scenarios/`.
- ATLAS root owns schemas, runners, artifact validation, reports, and promotion logic.

Lifeline satisfies QA LLEL through deterministic command and contract evidence.

- Required promotion evidence: `pnpm run verify`
- Required preflight evidence: `pnpm run typecheck`
- Visual and physical-device evidence are not part of the Lifeline v1 contract surface.
