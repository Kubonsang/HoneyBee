# ADR-010: Correlate ephemeral Runtime Runs and recover stale active Sessions

- Status: Retired — VS Code Extension removed by ADR-013
- Date: 2026-07-30

## Context

Honey Bee v0.x launches one sidecar Runtime for each VS Code Extension activation. The Runtime is not a long-lived Local Core and the Extension cannot reconnect to PTYs from a previous activation. Persisted `AgentSession.status` therefore cannot prove that a process is still alive. A crash or forced reload can leave `starting`, `running`, or `waiting_for_input` in `globalState`, while a late event from Run A can otherwise overwrite the state of a newer Run B.

Shutdown ownership was also split between context disposal, `deactivate()`, Console cleanup, Prompt durability queues, and transport disposal. A synchronous or fire-and-forget path could dispose the transport before final PTY status was durable, accept new mutations during teardown, or leave an Agent child alive. Node PTY cleanup is best effort on Windows and does not provide the process-tree guarantee of a native Job Object.

## Decision

The v0.x Runtime remains ephemeral: every activation creates a new Runtime generation, and Honey Bee never reconnects to or automatically restarts an Agent process from a previous activation. Metadata, Drafts, Prompt Attempts, Receipts, and Run history are restored; process continuity is not.

### Run and Runtime identity

Every packaged Runtime creates a unique `runtimeInstanceId` and returns it with its PID and protocol version from the `runtime.hello` handshake. Every Agent start receives a fresh branded `runId`. Protocol version 2 carries `runId` on start, input, resize, interrupt, stop, snapshot, PTY data, start, and exit messages.

`AgentSession.status` remains the UI-oriented current status. A strict version-1 `SessionRunRecord` owns execution identity, Runtime ownership, phase, timestamps, termination reason, and optional exit code. It stores no Prompt, terminal output, environment, command arguments, secret, or raw transport packet.

Run phases are monotonic:

```text
starting -> running | stopping | failed | interrupted
running <-> waiting-for-input
running | waiting-for-input -> stopping | completed | failed | interrupted
stopping -> stopped | completed | failed | interrupted
```

Terminal Runs never return to an active phase. A later start creates a new Run. The Repository rejects identity mutation, terminal-to-active reversal, and two active Runs for one Session.

### Correlation and status serialization

Runtime status and terminal data are applied only when both Session ID and `runId` match the current active Run. A stale Run event produces an identifier-only diagnostic and changes neither persistence nor UI. Duplicate terminal events are idempotently ignored. Status persistence is serialized per Session, while different Sessions have independent queues.

Termination semantics are distinct:

| Observation                     | Session / Run result                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| natural exit code 0             | `completed` / `process-exit-zero`                                |
| natural nonzero exit            | `failed` / `process-exit-nonzero`                                |
| explicit user stop or interrupt | `stopped` / `user-stop`                                          |
| Extension graceful shutdown     | `stopped` / `extension-shutdown`                                 |
| Runtime graceful shutdown       | `stopped` / `runtime-shutdown`                                   |
| unexpected Runtime disconnect   | current active Runs only: `interrupted` / `runtime-disconnected` |
| spawn or start failure          | `failed` / `start-failed`                                        |
| hard shutdown deadline          | unresolved active Runs: `interrupted` / `shutdown-timeout`       |

A clean Extension shutdown is control-plane lifecycle, not Agent failure. Unexpected disconnect does not rewrite already-terminal Runs. Ambiguous Prompt delivery remains governed by ADR-009 and is not reclassified as rejected.

### Startup stale recovery

After Prompt Attempt and Receipt reconciliation, but before Session selection, Console Draft restoration, or any Agent start, the Extension reconciles active Runs. Because a newly launched Runtime cannot own a previous `runtimeInstanceId`, persisted `starting`, `running`, `waiting-for-input`, and `stopping` Runs become `interrupted` with `recovered-stale-run`; matching active `AgentSession.status` becomes `stopped`. Legacy active Session status without a Run record is also stopped without inventing execution history.

An invalid Run store is preserved rather than overwritten. Active Session metadata still fails safely toward `stopped` so the UI does not claim unsupported process continuity. Terminal Sessions are unchanged. Reconciliation has no Runtime input dependency, starts zero Agents, sends zero Prompts, and leaves Drafts, Attempts, Receipts, and unknown Prompt locks unchanged.

### One asynchronous shutdown owner

`ExtensionLifecycleCoordinator` owns an idempotent shutdown Promise. Context disposal, `deactivate()`, and activation-failure cleanup join the same in-flight sequence:

```text
state -> shutting-down
-> reject new start, submit, retry, interrupt, resize, and raw input
-> drain Console delivery/recovery work and flush Draft debounce/write tails
-> persist current active Runs as stopping
-> request Runtime graceful shutdown
-> Runtime rejects new requests, snapshots active PTYs, stops each independently, and emits final status
-> await per-Session status queues and Run, Attempt, and Receipt write tails
-> hard-dispose transport/process resources
-> dispose listeners
-> state -> stopped
```

The graceful Runtime `shutdown()` operation is separate from transport `dispose()`. Multiple shutdown calls execute this sequence once and return the same report. The initial total deadline remains five seconds. At the deadline, the coordinator marks remaining current Runs `interrupted/shutdown-timeout`, attempts bounded hard disposal, reports unresolved Runs and safe warning codes, and returns rather than hanging. An uncooperative Promise cannot be forcibly cancelled in JavaScript; late work is suppressed from producing unhandled rejections, while hard transport disposal prevents further Runtime traffic.

### Runtime EOF and orphan limits

The JSONL Runtime stops accepting requests once shutdown starts. Explicit `runtime.shutdown` and stdin EOF both call the idempotent PTY manager shutdown, attempt every Session even if one stop fails, close logs, and emit final run-correlated exit events when stdout is available. The Runtime then exits or permits the Extension to dispose the transport.

On Windows, `node-pty` kill is the strongest portable mechanism currently used. It does not guarantee termination of every descendant after an Extension Host hard kill or OS crash. Shutdown reports unresolved counts and identifiers only. A native Job Object helper, Windows Service, or administrative process manager is outside this decision.

## Consequences

### Positive

- Persisted UI can no longer claim that an unowned process is still running after activation.
- Late Run A events cannot overwrite Run B state.
- Shutdown command gating, PTY cleanup, final status persistence, Prompt durability flush, and transport disposal have one awaitable owner.
- Normal shutdown, Agent failure, Runtime loss, and stale recovery remain distinguishable.
- One Session's status queue or stop failure does not serialize unrelated Sessions.

### Costs and limitations

- Protocol v2, Run persistence, handshake identity, and lifecycle tests add state and coordination code.
- `globalState` write serialization is per Repository instance, not a cross-process transaction.
- The five-second bound can report unresolved cleanup; JavaScript cannot forcibly cancel every in-flight storage Promise.
- Windows child-process cleanup remains best effort without Job Objects.
- Run history is minimal lifecycle history, not event sourcing or terminal scrollback.

## Local Core boundary

A future long-lived Local Core may own PTYs independently of VS Code activation, expose a durable Runtime inventory, and support authenticated reattachment. At that point, startup must prove ownership through the Core instead of declaring every previous Runtime generation stale. Automatic restart still requires a separate user policy and is not implied by reattachment.

## Alternatives considered

### Trust persisted `AgentSession.status`

Rejected because a scalar status has no current process, Runtime, or Run ownership evidence.

### Automatically restart stale active Sessions

Rejected because it can duplicate commands, violate Prompt unknown-outcome locks, and surprise users after a crash.

### Keep shutdown in `extension.ts`

Rejected because overlapping disposal entry points need one idempotent Promise, report, ordering, and timeout owner.

### Add a native Windows Job Object helper now

Deferred because the vertical slice can improve graceful cleanup and report unresolved work without introducing native privilege, packaging, and service lifecycle scope.

## Related decisions

- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-008](ADR-008-persist-delivered-prompt-receipts.md)
- [ADR-009](ADR-009-persist-prompt-delivery-attempt-journal.md)
