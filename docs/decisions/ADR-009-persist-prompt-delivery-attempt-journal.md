# ADR-009: Persist Prompt delivery Attempts and require explicit unknown-outcome recovery

- Status: Retired — VS Code Extension removed by ADR-013
- Date: 2026-07-30

## Context

A PTY write and VS Code `globalState` update cannot participate in one atomic transaction. PR #2 durably records a Receipt after `RuntimeClientPort.sendInput()` reports acceptance, but a crash while dispatching or before the Receipt write can leave the Extension unable to prove whether the Runtime handled the request. Treating that interval as rejected and retrying could execute the Prompt twice; treating it as delivered could hide an input that never reached the Runtime.

End-to-end exactly-once delivery is therefore not a credible claim. The Runtime acknowledgement observes only that the input request reached the PTY write API. It does not prove that the Agent read, understood, executed, or completed the Prompt, and PTY output is not delivery evidence.

## Decision

Persist a strict, content-minimized `PromptDeliveryAttempt` before every Prompt Runtime call. The Attempt identity contains the request ID, Session ID, exact SHA-256 digest, UTF-8 byte length, timestamps, phase, schema version, and an optional replacement request ID. Prompt content, excerpts, terminal echo, and reversible encodings are prohibited.

Attempt identity is immutable and phase transitions are monotonic:

```text
prepared -> dispatching
prepared -> cancelled-before-dispatch
dispatching -> runtime-accepted
dispatching -> unknown
unknown -> resolved-assumed-delivered
unknown -> resolved-retried
```

The phases mean:

| Phase                        | Meaning                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prepared`                   | Draft and Attempt identity are durable; Runtime dispatch has not started.                                          |
| `dispatching`                | This phase was durably flushed before the one Runtime call began. Without later evidence, the result is uncertain. |
| `runtime-accepted`           | The local Runtime call returned accepted and that observation is durable.                                          |
| `unknown`                    | Dispatch began, but no durable accepted or explicit rejection evidence survived.                                   |
| `cancelled-before-dispatch`  | Startup proved that a prepared Attempt never began dispatch.                                                       |
| `resolved-assumed-delivered` | The user chose to treat an unknown result as delivered; this is not confirmed delivery.                            |
| `resolved-retried`           | The user accepted duplicate risk and the replacement request was accepted under a new request ID.                  |

A Runtime response is `rejected` only when it proves that PTY dispatch did not occur, such as a missing Session, a stopped PTY, pre-dispatch validation failure, or an explicit Runtime rejection. Timeout, disconnect, child-process loss, correlation loss, and a transport failure after writing may all have dispatched input and are classified as `unknown`.

## Ordering

Prompt delivery uses this order:

```text
exact Draft save
-> prepared Attempt save and flush
-> dispatching Attempt save and flush
-> Runtime sendInput exactly once
-> accepted: durable runtime-accepted Attempt
-> pending Receipt
-> exact Draft cleanup
-> cleared Receipt
-> Attempt finalization and bounded pruning
```

Any Draft, prepared, dispatching, or pre-call flush failure results in zero Runtime calls and preserves the Draft. Explicit Runtime rejection preserves the Draft and creates no Receipt. Unknown preserves the Draft and Attempt, creates no Receipt, locks only that Session, and is never automatically retried. A Receipt remains authoritative accepted evidence when its identity exactly matches the Attempt.

## Startup reconciliation

Attempt reconciliation runs before Receipt reconciliation, Session selection, Console Draft restoration, and user input:

- `prepared` becomes `cancelled-before-dispatch`; its Draft is preserved and normal submission is allowed.
- `dispatching` without matching Receipt becomes `unknown`; its Draft is preserved and that Session is locked.
- `runtime-accepted` without a Receipt reconstructs a pending Receipt using the original `acceptedAt`, never the current time.
- an exact matching Receipt finalizes the Attempt as authoritative local accepted evidence;
- identity conflicts cause no overwrite, Draft mutation, or automatic resolution;
- `unknown` remains unresolved and visible to the user.

Neither reconciler depends on the Runtime, and activation performs zero Prompt input calls.

## User resolution

“Assume delivered” records `resolved-assumed-delivered`. It may remove only an exact, not-newer Draft; a different or newer Draft is preserved. It does not synthesize a Receipt because the choice is a user assumption, not observed Runtime acceptance.

“Retry with new request ID” requires an exact Draft and explicit duplicate-risk confirmation. It enters the normal delivery pipeline under a fresh request ID. The original becomes `resolved-retried` only after the replacement is accepted; rejected or unknown replacements leave the original unresolved, and a replacement unknown remains queued for the same Session. Duplicate or stale actions are idempotent. Closing the warning leaves the persisted issue and Session lock intact.

## Privacy and retention

Attempts and Receipts store equality evidence and identifiers only. Prompt source is absent from storage, status messages, notifications, and diagnostics. Output diagnostics use safe typed codes plus Session/request IDs.

The initial policy keeps the newest 1,000 terminal Attempts globally. `prepared`, `dispatching`, `runtime-accepted`, and `unknown` Attempts are not automatically pruned. The `globalState` adapter serializes mutations and exposes `flush()`; bounded shutdown awaits Draft work, active delivery/recovery work, Attempt and Receipt write tails, reconciliation mutations, and Runtime disposal for up to five seconds.

## Consequences

### Positive

- A crash before Runtime dispatch is safely distinguished from a crash after dispatch began.
- Durable accepted Attempts can reconstruct missing Receipts without re-sending input.
- Ambiguous outcomes are represented honestly and isolated to one Session.
- User recovery cannot silently reuse the original request identity or manufacture accepted evidence.

### Costs and limitations

- Attempt lifecycle, retention, reconciliation, and recovery UX add state and tests.
- `globalState` serialization is per Repository instance, not a cross-process transaction.
- If the process dies after the durable `dispatching` phase and the Runtime may have written input, but before `runtime-accepted` or a Receipt becomes durable, restart can only classify the outcome as `unknown`.
- The Runtime acknowledgement still stops at the PTY write API and cannot establish Agent consumption or exactly-once execution.

## Alternatives considered

### Automatically resend dispatching Attempts

Rejected because a timeout or crash can occur after PTY input was written, causing duplicate command execution.

### Infer delivery from terminal output

Rejected because terminal echo and Agent output are neither correlated nor durable delivery acknowledgements.

### Store Prompt content for recovery

Rejected because digest and byte length are enough for exact Draft comparison, while durable Prompt content would increase privacy and secret-exposure risk.

### Mark Assume delivered as a Receipt

Rejected because it would conflate a user decision with observed Runtime acceptance and corrupt Receipt semantics.

## Related decisions

- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-008](ADR-008-persist-delivered-prompt-receipts.md)
