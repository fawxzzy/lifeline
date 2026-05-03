# Lifeline proof-reference receipt contract

This document is the Lifeline-owned contract for final receipts that adopt a Cortex proof-reference pack after explicit human approval.

Related policy:

- Production promotion eligibility is governed separately by `docs/contracts/proof-reference-receipt-promotion-policy.md`.

## Ownership split

- Cortex may assemble proof-reference packs and approval-gated write-ready artifacts.
- Cortex must not invent Lifeline receipt truth, auto-approval, or receipt schema.
- Lifeline owns the final receipt that records when a proof-reference pack was accepted as the auditable owner-repo receipt.
- Human approval remains explicit and must be preserved into the final receipt.

## Contract register

| Contract | Version | Owner | Purpose | Canonical artifact |
| --- | --- | --- | --- | --- |
| `atlas.ui.proof-passed.receipt.v1` | v1 | Lifeline execution / receipt surface | proof-summary-driven receipt written directly from ATLAS UI proof summaries | `docs/contracts/ui-proof-passed-receipt-contract.md` |
| `atlas.lifeline.proof-reference.receipt.v1` | v1 | Lifeline execution / receipt surface | final Lifeline receipt for a Cortex proof-reference pack with explicit human approval | `schemas/proof-reference-receipt.schema.json` |

## Receipt shape

Required top-level fields:

- `contract_version`
- `receipt_id`
- `emitted_at`
- `runner_version`
- `status`
- `source_repo_id`
- `tranche_id`
- `source_artifacts`
- `approval`
- `boundary`
- `proof_summary`
- `proof_refs`
- `source_refs`
- `validation_context`

Required `source_artifacts` fields:

- `proof_reference_pack_ref`
- `proof_reference_pack_digest`
- `write_ready_artifact_ref`

Required `approval` fields:

- `explicit_human_approval`
- `auto_approved`
- `approved_at`
- `approval_note`

Approval reviewer identity requires at least one of:

- `reviewer_id`
- `reviewer_label`

Required `boundary` fields:

- `final_receipt_owner`
- `prepared_by`
- `statement`

Required `proof_summary` fields:

- `owner_repo_id`
- `summary_ref`
- `report_id`

Required `proof_refs` fields:

- `semantic_report_ref`
- `visual_report_ref`

Optional proof report identifiers:

- `proof_refs.semantic_report_id`
- `proof_refs.visual_report_id`

Required `validation_context` fields:

- `known_ambient_debt`
- `current_validation_debt`

## Emission rules

- Lifeline may emit `atlas.lifeline.proof-reference.receipt.v1` only after explicit human approval.
- `approval.explicit_human_approval` must be `true`.
- `approval.auto_approved` must remain `false`.
- Lifeline must reject emission if neither `approval.reviewer_id` nor `approval.reviewer_label` is present.
- Lifeline must reject emission when `validation_context.current_validation_debt` is non-empty.
- Lifeline may preserve `validation_context.known_ambient_debt` as audit context, but ambient debt must not be rewritten as current validation debt.
- Lifeline must reject emission when `proof_summary.owner_repo_id` does not match `source_repo_id`.
- Lifeline must reject emission when `source_refs` does not include the proof-reference pack ref, the write-ready artifact ref, the proof summary ref, and both proof report refs.
- Lifeline must reject emission when any required proof ref or any destination path segment would cause the receipt write to escape the Lifeline-owned receipt destination.

## Boundary rules

- `boundary.final_receipt_owner` must be `lifeline`.
- `boundary.prepared_by` must be `cortex`.
- `boundary.statement` must explicitly preserve the owner split: Cortex prepared the proof-reference material, but Lifeline owns final receipt truth.
- The receipt remains proof-reference-first. It must not copy full proof payloads out of the proof summary or proof reports.
- Path-like refs must stay stack-relative and slash-normalized before write.
- Lifeline stamps the final emitted receipt with the Lifeline-owned runner identifier `lifeline.proof-reference-receipt.v1` before write.

## Final receipt destination

- Lifeline writes final proof-reference receipts only under `.lifeline/receipts/proof-reference-accepted/<source_repo_id>/<tranche_id>/<receipt_id>.json` relative to the Lifeline repo root.
- The writer emits exactly one final receipt artifact for a candidate receipt id.
- Lifeline does not define a `latest.json` alias, secondary summary file, or alternate receipt mirror for this contract.

## Audit index

- Lifeline may scan `.lifeline/receipts/proof-reference-accepted/**` to build a deterministic read-only audit index over final proof-reference receipts.
- The audit index must validate every discovered receipt against `schemas/proof-reference-receipt.schema.json`.
- The audit index may report receipt inventory, source repo and tranche mappings, proof-reference totals, and policy-risk flags such as ambient debt, current validation debt, missing boundary statements, or `auto_approved` drift.
- The audit index must not mutate receipt payloads, repair receipt content, promote receipts, or invent alternate receipt truth.
- The audit index may remain stdout-only by default; if Lifeline writes an audit artifact, that artifact must stay under a Lifeline-owned audit path and must not change the underlying receipt files.

## Current lane posture

- Lane U proved the isolated end-to-end roundtrip without mutating production Lifeline receipts.
- Lane V defines the production promotion policy that must be satisfied before any real Lifeline receipt event is even eligible.
- Lane Y adds deterministic read-only audit indexing over final Lifeline proof-reference receipts before any connector-backed publication or external evidence inventory.
- A passing isolated roundtrip is evidence that the mechanics work; it is not permission to write production receipts.

- Rule: Lifeline owns final receipt truth; Cortex may only prepare inputs until Lifeline writes the final receipt.
- Pattern: contract first, isolated roundtrip second, promotion policy third, production dry-run fourth, final write last.
- Failure Mode: treating isolated roundtrip success or explicit approval alone as permission to bypass schema validation, boundary checks, current-validation-debt blocking, or path safety.

- Rule: final receipt writes must be followed by deterministic read-only auditability.
- Pattern: once production promotion exists, inventory and validation come before connector-backed evidence or publication.
- Failure Mode: do not let the audit index become a repair tool, promotion tool, connector publisher, or hidden receipt mutator.
