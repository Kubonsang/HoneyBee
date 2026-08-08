# ADR-008: Persist delivered Prompt receipts without storing Prompt content

- Status: Retired — VS Code Extension removed by ADR-013
- Decision date: 2026-07-30

## Context

PR #1 preserves a Session Draft until `RuntimeClientPort.sendInput()` succeeds and clears it only after a correlated `prompt.accepted` acknowledgement. A remaining recovery gap exists when Runtime input succeeds but Draft deletion fails: after Extension restart, the delivered text can reappear as an ordinary Draft and invite a duplicate submission.

Honey Bee needs durable evidence of the successful Runtime call without turning Prompt bodies into a history store. The evidence must support startup cleanup, tolerate local storage failures without reclassifying Runtime success, and remain bounded.

## Decision

Persist a versioned `PromptDeliveryReceipt` after `RuntimeClientPort.sendInput()` returns successfully. A Receipt means only that this Extension-to-Runtime call returned successfully. It does not prove that the PTY program consumed, understood, or completed the Prompt.

### Receipt data minimization

The strict schema stores only:

- request and Session identifiers;
- `sha256:<lowercase-hex>` of the exact UTF-8 Prompt bytes;
- exact UTF-8 byte length;
- delivery timestamp;
- Draft cleanup state (`pending` or `cleared`);
- schema version 1.

Prompt content is never stored in a Receipt, Output Channel diagnostic, warning detail, or recovery report. Hash input is not trimmed and has no newline or Unicode normalization. One shared fingerprint function computes both delivery and reconciliation values.

### Ordering

One delivery attempt follows this order:

1. validate non-empty content;
2. persist the exact Draft;
3. call Runtime input exactly once;
4. persist a `pending` Receipt;
5. attempt Draft deletion;
6. update the Receipt to `cleared` when deletion succeeds;
7. prune old cleared Receipts.

Runtime failure creates no Receipt and preserves the Draft. Receipt, cleanup-state, Draft-deletion, and prune failures are separate typed outcomes. Once Runtime input succeeds, later persistence failures produce `prompt.accepted` with local durability warnings and never cause automatic Runtime retry.

### Reconciliation

Activation runs reconciliation after Repository creation and before Session selection or Console Draft restoration. A Draft is deleted only when Session ID, exact digest, UTF-8 byte length, and the pre-delivery timestamp guard all match a Receipt. Missing Drafts resolve pending Receipts to cleared. Different or newer Drafts are preserved and the old pending Receipt is resolved. Invalid Receipt storage or Repository failures fail toward Draft preservation.

Reconciliation performs cleanup only. It has no Runtime dependency and never sends Prompt input.

### Retention

The initial policy retains the newest 1,000 cleared Receipts globally. Oldest cleared Receipts are pruned first. Pending Receipts are never automatically pruned. The VS Code `globalState` adapter serializes mutations per Repository instance and exposes `flush()` so shutdown can await its write tail.

### Exactly-once non-goal

This decision does not provide end-to-end exactly-once delivery. A process crash after Runtime input succeeds but before Receipt persistence leaves an unknown outcome because the Runtime has no durable deduplication or acknowledgement protocol. A pre-delivery journal and unknown-outcome recovery UX are separate work.

## Consequences

### Positive

- A cleanup outage followed by restart no longer resurrects an exact delivered Draft when its Receipt was persisted.
- Different or newer user Drafts survive reconciliation.
- Recovery evidence is content-minimized and bounded.
- Runtime delivery and local persistence failures remain semantically distinct.

### Costs and limitations

- `globalState` read-modify-write storage is serialized only within one Repository instance; it is not a cross-process transaction.
- Receipts add schema, retention, reconciliation, and shutdown responsibilities.
- The post-Runtime/pre-Receipt crash window remains ambiguous.

## Alternatives considered

### Store Prompt content in a delivery history

Rejected because recovery needs equality evidence, not a durable content history, and storing user Prompt bodies increases privacy and secret-exposure risk.

### Delete the Draft before Runtime input

Rejected because Runtime failure would lose the user's only durable copy.

### Treat Receipt persistence failure as Runtime failure and retry

Rejected because Runtime input has already occurred and retry can execute a duplicate command.

### Implement a pre-delivery journal in this PR

Deferred. It can identify unknown outcomes but requires a user-facing resolution policy or Runtime durable deduplication.

## Validation

- strict Domain/hash tests for schema and exact UTF-8 fingerprints;
- In-memory and globalState Repository tests for validation, deterministic updates, concurrent writes, flush, and retention;
- delivery ordering and failure-combination tests;
- startup reconciliation safety and no-Runtime-dependency tests;
- restart Integration tests with injected Draft cleanup failure;
- VS Code Extension Host activation test with persisted matching and newer Draft fixtures.

## Related decisions

- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
