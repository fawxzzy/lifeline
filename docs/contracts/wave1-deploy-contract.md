# Wave 1 deploy contract

Wave 1 defines a narrow deploy contract for Lifeline release planning. It does not widen Lifeline into a hosted control plane. The contract exists so ops and rollback tooling can read one stable release record and so dry-run planning can be deterministic.

## Contract versions

- `atlas.lifeline.deploy-contract.v1`
- `atlas.lifeline.release-metadata.v1`
- `atlas.lifeline.deploy-dry-run.v1`

## Deploy manifest shape

The deploy manifest is a JSON object with:

- `contractVersion`
- `appName`
- `artifactRef`, `imageRef`, or `repo` + `branch`
- `route.domain`
- `route.path` when the route is not rooted
- `envRefs`
- `healthcheckPath`
- `migrationHooks.preDeploy`
- `migrationHooks.postDeploy`
- `migrationHooks.rollback`
- `migrationHooks.preActivate`
- `migrationHooks.postActivate`
- `migrationHooks.preRollback`
- `rollbackTarget.releaseId`
- `rollbackTarget.artifactRef`
- `rollbackTarget.strategy`

Canonical validation accepts `artifactRef`, `imageRef`, or a branch-shaped `repo` + `branch` input and normalizes all of them to `artifactRef` for downstream use.

## Release metadata shape

Release metadata is the persisted record ops and rollback tooling consume after a deploy decision. It keeps the normalized deploy contract plus:

- `releaseId`
- `releaseTarget.kind`
- `releaseTarget.releaseId`
- `releaseTarget.artifactRef`
- `sourceAdapter.kind` when a compatibility adapter was used
- `dryRun`
- `createdAt`
- `validation.status`
- `validation.issues`

`releaseId` is deterministic from the normalized release target unless a caller intentionally pins it. `releaseTarget` is the concrete Wave 1 handoff surface for downstream consumers: a single-host immutable release identified by `releaseId` and `artifactRef`.
When the input arrived as `imageRef` or `repo` + `branch`, Lifeline preserves that fact in `sourceAdapter` while still normalizing the persisted release target to `artifactRef`.

The persisted metadata stays JSON only, with no hosted control-plane state embedded.

Phase hook arrays stay as command strings. Lifeline does not invent a new hook DSL for Wave 1.

## Dry-run path

The dry-run path is a pure planning path:

1. validate the deploy manifest
2. canonicalize `artifactRef`
3. assemble release metadata
4. derive the concrete release target
5. preserve rollback target metadata unchanged

Dry-run planning must not mutate the input manifest or write state. It only emits a plan object and a release metadata preview.

## Immutable single-host release engine

Wave 1 release execution is local-first and single-host:

- each release is persisted once at `.lifeline/releases/<app>/<releaseId>/metadata.json`
- release directories are immutable after the metadata lands
- mutable activation state lives only in `.lifeline/releases/<app>/current.json` and `previous.json`
- `<app>` is a single filesystem path segment derived from `appName`, so absolute values, separator-bearing values, and `.` or `..` are rejected before any release path is built
- activation is health-gated before the current pointer advances
- failed health gates preserve the existing current and previous release pointers
- rollback promotes the previous known-good release back to current
- activation runs `preActivate` before the health gate and before any pointer mutation
- activation runs `postActivate` only after a provisional activation has succeeded
- rollback runs `preRollback` before the rollback health gate and before any pointer mutation
- failed pre-activation or pre-rollback work preserves the existing pointers
- failed post-activation work restores the original pointers before the failure receipt is written
- plan, activation, failed activation, and rollback each emit a receipt under `.lifeline/releases/<app>/receipts/`

This keeps the durable release target explicit without widening Lifeline into preview URLs, hosted control-plane behavior, domains, or TLS management.

Phase evidence is recorded in the release receipt so operators can see which commands ran and which phase blocked the transition.

## Schema files

- [`../../schemas/wave1-deploy-contract.schema.json`](../../schemas/wave1-deploy-contract.schema.json)
- [`../../schemas/wave1-release-metadata.schema.json`](../../schemas/wave1-release-metadata.schema.json)
