# Lifeline proof-reference receipt promotion policy

This document defines the Lifeline-owned policy that decides whether an isolated Cortex proof-reference receipt candidate is eligible for promotion into a real Lifeline receipt event.

## Scope

- This policy is owner-side and decision-only.
- It evaluates whether promotion is permitted.
- It does not write production receipts.
- It does not widen Cortex authority, add connector evidence, or authorize autonomous receipt mutation.

## Promotion decision inputs

The policy evaluates two inputs together:

- A schema-compatible proof-reference receipt candidate payload.
- An explicit promotion context supplied by Lifeline:
  - `production_promotion_requested`
  - `dry_run_test_receipt_passed`
  - `source_candidate_path`
  - `evidence_origin`
  - `stable_proof_reference`

## Promotion requirements

A candidate is eligible for production promotion only when all of the following are explicit and true:

- Lifeline schema validation passed.
- Explicit human approval is present.
- `approval.auto_approved` is `false`.
- Human approval metadata is present.
- `validation_context.current_validation_debt` is empty.
- Proof references are canonical, stack-relative, and slash-normalized.
- The owner-boundary statement is valid and preserves that Cortex prepared the material while Lifeline owns final receipt truth.
- `source_repo_id`, `tranche_id`, and `receipt_id` are explicit and unambiguous.
- Receipt destination segments are safe.
- `source_candidate_path` is explicit.
- Production promotion is intentionally requested.
- The isolated dry-run or test receipt already passed.
- Connector-derived evidence is rejected unless it carries a stable proof reference.

## Promotion blockers

Promotion must be blocked when any of the following are present:

- missing approval
- missing approval metadata
- current validation debt
- schema failure
- non-canonical references
- invalid owner-boundary statement
- source repo mismatch between summary ownership and destination ownership
- ambiguous source repo, tranche, or receipt identifiers
- unsafe destination segments
- missing explicit source candidate path
- missing explicit production intent
- missing isolated dry-run confirmation
- `auto_approved=true`
- connector-derived evidence without a stable proof reference

## Deterministic decision contract

- The evaluator returns a promotion decision plus blocker codes.
- The evaluator is read-only.
- A blocked decision must leave production Lifeline receipt state unchanged.
- The evaluator may reuse the same candidate-validation vocabulary as the final receipt writer, but promotion eligibility is stricter than isolated roundtrip compatibility.

## Production dry-run semantics

- A production dry-run may compute promotion eligibility and the exact intended Lifeline receipt destination.
- A production dry-run must not write final receipts.
- A successful dry-run is evidence about the target write path and blocker state; it is not production write authority.

## Lane posture

- Lane U proved the isolated end-to-end roundtrip: Cortex candidate payload to Lifeline writer to temp final receipt to schema and contract validation.
- Lane V governs when that isolated success may be promoted toward a real Lifeline receipt event.
- Lane W is the first lane that may surface a production dry-run decision and target path without writing.
- Lane X is the first lane that may perform a human-approved production receipt write, and only with explicit approval metadata plus an explicit production-promotion flag.
- Lane Y is the mandatory read-only auditability follow-up: deterministic receipt indexing over final Lifeline proof-reference receipts before any connector-backed evidence publication.

Rule:
A Lifeline receipt may only be promoted from isolated proof to production receipt when promotion intent, human approval, schema validity, zero current validation debt, and path safety are all explicit.

Pattern:
Roundtrip proof validates mechanics; promotion policy governs production eligibility.

Failure Mode:
Do not treat a passing isolated roundtrip as permission to write production receipts automatically.

Rule:
A production receipt dry-run may compute eligibility and destination, but it must not write final receipts.

Pattern:
Promotion policy decides eligibility; dry-run proves the target write without mutating receipt truth.

Failure Mode:
Do not let a successful dry-run become implicit permission for production receipt emission.

Rule:
A production receipt promotion may write exactly one final Lifeline receipt only when production intent, explicit human approval, dry-run success, schema validity, zero current validation debt, and path safety all pass together.

Pattern:
Dry-run proves the target; promotion performs the write through the existing Lifeline-owned writer without adding new receipt truth.

Failure Mode:
Do not let production_promotion_requested, human approval metadata, or dry-run success individually imply approval; all gates must pass together.

Rule:
Once write power exists, auditability comes next.

Pattern:
Production receipt emission must be paired with deterministic read-only indexing before external evidence integrations.

Failure Mode:
Do not add connectors before receipt inventory, validation, and audit reporting are stable.
