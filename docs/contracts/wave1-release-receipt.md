# Wave 1 Release Receipt Contract

Wave 1 release receipts are part of the operator evidence surface. They are written under `.lifeline/releases/<app>/receipts/` for release planning, activation, rollback, and failed release transitions.

## Contract version

- `atlas.lifeline.release-receipt.v1`

## Common fields

Every release receipt includes:

- `contractVersion`
- `receiptId`
- `action`
- `status`
- `appName`
- `releaseId`
- `createdAt`
- `releaseDirectory`
- `releaseMetadataPath`
- `currentPointerPath`
- `previousPointerPath`
- `releaseTarget`
- `rollbackTarget`

Optional fields appear only when the transition requires them:

- `previousReleaseId`
- `sourceAdapter`
- `health`
- `phaseEvidence`
- `failedPhase`
- `preservedCurrentReleaseId`
- `preservedPreviousReleaseId`
- `revertedPointers`
- `lineage`

## Action variants

### Planned receipt

`lifeline release persist` writes a `planned` receipt:

- `action=planned`
- `status=planned`
- no phase evidence, failed phase, or lineage
- optional `sourceAdapter` when deploy-contract compatibility normalization occurred

### Activate receipt

Activation success records:

- `action=activate`
- `status=succeeded`
- `health`
- `phaseEvidence.preActivate`
- `phaseEvidence.postActivate`
- `lineage`
- `lineage.promotedFromReleaseId` is present when the activation displaced an existing current release

Activation failure records:

- `action=activate`
- `status=failed`
- `failedPhase`
- `phaseEvidence`
- `health` when the failure phase is `healthcheck`
- preserved pointer ids when the failed transition had an existing current or previous release
- `revertedPointers=true` when `postActivate` failed after provisional pointer movement

### Rollback receipt

Rollback success records:

- `action=rollback`
- `status=succeeded`
- `previousReleaseId`
- `health`
- `phaseEvidence.preRollback`
- `lineage`
- rollback success always includes both `lineage.promotedFromReleaseId` and `lineage.promotedToReleaseId`

Rollback failure records:

- `action=rollback`
- `status=failed`
- `previousReleaseId`
- `failedPhase`
- `phaseEvidence.preRollback`
- `health` when the failure phase is `healthcheck`
- preserved pointer ids for the held current and previous release lineage

## Phase evidence contract

Phase evidence records the concrete commands Lifeline ran before the transition continued or failed:

- `phaseEvidence.<phase>.phase`
- `phaseEvidence.<phase>.status`
- `phaseEvidence.<phase>.commands[]`
- `phaseEvidence.<phase>.commands[].command`
- `phaseEvidence.<phase>.commands[].status`
- `phaseEvidence.<phase>.commands[].exitCode`
- optional `signal`

## Rule

Operator evidence must be schema-backed and deterministic before it is written to disk.

## Pattern

Validate release receipts at emission time and verify the emitted receipts deterministically across success and failure paths.

## Failure Mode

If receipt fields drift silently, status surfaces and rollback evidence can look valid while operators are actually reading an undocumented or partial contract.

## Schema file

- [`../../schemas/wave1-release-receipt.schema.json`](../../schemas/wave1-release-receipt.schema.json)
