# Wave 1 Release Pointer Operations

Use this runbook when promoting or rolling back a persisted Wave 1 release. These commands mutate the local current/previous release pointers under `.lifeline/releases/<app>/`.

## Rule

Destructive release pointer movement must be intentionally acknowledged at the CLI boundary.

## Pattern

- `lifeline release plan` and `lifeline release persist` stay frictionless because they do not move live release pointers.
- `lifeline release activate` and `lifeline release rollback` require explicit confirmation in interactive operator sessions because they mutate current and previous release state.

## Activate

1. Persist or identify the target release id.
2. Re-run the activation command with explicit confirmation:

   ```bash
   lifeline release activate <app-name> <release-id> --yes
   ```

3. Inspect the emitted receipt and operator status evidence after the pointer move completes.

## Rollback

1. Confirm `lifeline status` reports both `rollbackReady: yes` and `rollbackConfidence: ready`.
2. If `rollbackConfidence` is degraded, stop and fix the reported mismatch before moving the release pointers.
3. Re-run the rollback command with explicit confirmation:

   ```bash
   lifeline release rollback <app-name> --yes
   ```

4. Inspect the rollback receipt and operator evidence before treating the release as recovered.

## Failure Mode

A copied command, shell-history replay, or automation typo can move release pointers without the operator explicitly accepting the mutation. The CLI guardrail blocks that path and prints the exact confirmed command to run next.
