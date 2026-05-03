# Topology manifest intake contract

Lifeline consumes the ATLAS-owned topology manifest as an intake contract for public app and operator hostname resolution. Lifeline does not become the source of truth for zones, public hostname policy, DNS automation, TLS automation, or reverse-proxy ownership.

## Canonical source

- ATLAS root manifest: `../../docs/LIFELINE_TOPOLOGY_MANIFEST.json`
- ATLAS source docs:
  - `../../docs/LIFELINE_HOSTING_TOPOLOGY.md`
  - `../../docs/LIFELINE_ENV_AND_DOMAIN_CONTRACT.md`

The canonical manifest schema version is `atlas.topology.manifest.v1`.

## Lifeline intake responsibilities

- validate the manifest shape before using it
- resolve one stable service identity at the `app/environment` layer
- resolve public hostname intent without embedding placement identity
- preserve app-specific exceptions such as Lifeline prod using `lifeline.{zone}`
- treat `dev` as local-only with no public hostname

## Resolution rules

- Stable service key template: `{app}/{environment}`
- Named environments:
  - `dev`
  - `preview`
  - `prod`
- Approved ephemeral public environment template: `pr-{number}`
- Default hostname templates:
  - prod: `{app}.{zone}`
  - preview: `preview-{app}.{zone}`
  - pr preview: `pr-{number}.{app}.{zone}`
- Lifeline exception:
  - prod: `lifeline.{zone}`
  - preview: no public hostname
  - pr preview: no public hostname

Lifeline resolution must prefer app-specific hostname rules over generic rules and must keep the public unit stable even when no public hostname is emitted.

## Out of scope

This intake contract explicitly excludes:

- hosted control plane behavior
- reverse proxy ownership
- domain automation
- TLS automation
- multi-node orchestration
