# Vertical Slice 1 validation

Date: 2026-07-30 (Asia/Seoul)

## Outcome

The automated Windows vertical slice is green: repository quality gates, architecture rules, strict typechecks, both esbuild bundles, 200 Vitest cases, a real packaged-runtime PTY round trip, the Git for Windows bundled Vim TUI smoke, and the official VS Code Extension Host smoke test passed. Eleven cases in the required matrix are PASS; the visual/IME/Neovim case is BLOCKED and is deliberately not counted as a pass.

## Environment

- OS: Microsoft Windows NT 10.0.26200.0 (x64)
- Node.js: 24.13.1
- pnpm: 11.18.0 through Corepack
- Installed VS Code CLI: 1.116.0 (x64)
- VS Code Test stable archive: 1.131.0
- `code`: found at `C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`
- `vim` on PATH: not found; Git-bundled Vim: `C:\Program Files\Git\usr\bin\vim.exe` (validated)
- `nvim`: not found

## Required 12-case matrix

| ID    | Status  | Scope and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VS-01 | PASS    | Root formatting, ESLint, strict package typechecks, build, tests, and dependency-cruiser run from `corepack pnpm verify`; 125 source modules and 167 dependencies had no violations. Generated `dist`, `.vscode-test`, coverage, and runtime-state directories are explicitly excluded from architecture analysis.                                                                                                                                                                                                                                                                         |
| VS-02 | PASS    | Domain/persistence tests cover session creation, tag rules, parent/related integrity, cycle/self-reference rejection, CRUD, query ordering, and delete detachment: `packages/domain`, `packages/persistence`, and extension application tests all passed.                                                                                                                                                                                                                                                                                                                                  |
| VS-03 | PASS    | `GlobalStateSessionRepository`, per-session drafts, and selected Session ID survive new repository instances. Missing or schema-invalid selected IDs are cleared and fall back to no selection; draft `session-2` restores as `second`.                                                                                                                                                                                                                                                                                                                                                    |
| VS-04 | PASS    | The default runtime is built into `apps/vscode-extension/dist/runtime/cli.cjs`, resolved from the absolute extension root, and packaged with node-pty workers, license, and Windows x64/arm64 native assets. Explicit command and argv (including quotes, metacharacters, spaces, and Korean) remain separate and unchanged.                                                                                                                                                                                                                                                               |
| VS-05 | PASS    | `CustomCommandAgentAdapter` normalizes `C:\프로젝트 파일\Hive (A)\child\..\worktree`, preserves `literal "quote" & \| ^ %PATH%` as one argv item, merges the Windows environment case-insensitively, and keeps `shell: false`.                                                                                                                                                                                                                                                                                                                                                             |
| VS-06 | PASS    | JSONL tests cover fragmented/multiple lines, malformed JSON, strict schemas, correlated typed errors, request timeout/exit behavior, and separation of protocol-only stdout from diagnostic stderr.                                                                                                                                                                                                                                                                                                                                                                                        |
| VS-07 | PASS    | Real Windows ConPTY launches a copied Echo Fixture from `Honey Bee 한글 PTY ...\도구 경로 (공백)\Echo 벌 Fixture.js`; greeting, ANSI, UTF-8 `한글`/bee emoji, resize, literal metacharacters, exit 7, and full log all passed.                                                                                                                                                                                                                                                                                                                                                             |
| VS-08 | PASS    | A 10,000-character Echo Fixture burst causes the 4,096-byte in-memory ring snapshot to report truncation while the full PTY log retains at least 10,000 payload characters; terminal control sequences are allowed between rendered runs.                                                                                                                                                                                                                                                                                                                                                  |
| VS-09 | PASS    | Real PTY tests cover natural non-zero exit 7, immediate exit 9, and Ctrl+C interrupt with `INTERRUPTED`, exit code 130, `reason: interrupted`, and zero active sessions afterward; unit tests retain stop/force-kill coverage.                                                                                                                                                                                                                                                                                                                                                             |
| VS-10 | PASS    | The extension JSONL client starts the packaged sidecar from an unrelated temporary cwd, launches Echo Fixture, resizes, sends ANSI input, observes successful PTY exit, and keeps diagnostics protocol-clean.                                                                                                                                                                                                                                                                                                                                                                              |
| VS-11 | PASS    | esbuild produced the webview JS/CSS, `extension.cjs`, and packaged runtime; `@vscode/test-cli`/`@vscode/test-electron` launched VS Code 1.131.0, activated `honeybee.honey-bee-vscode`, reconciled persisted Receipt/Draft and Attempt fixtures before Console restore, converted dispatching to unknown, reconstructed a runtime-accepted Receipt, preserved a newer Draft, recovered a persisted stale running Session as stopped/interrupted without a Runtime start or Prompt resend, preserved its unknown Prompt lock, found all 13 public commands, executed refresh, and exited 0. |
| VS-12 | BLOCKED | Git for Windows bundled Vim passed a real 100x30 ConPTY smoke with ANSI and alternate-screen output, `-Nu NONE -n -i NONE`, `Esc :q!`, exit code 0, and no active session afterward. Neovim is absent, and rendered GUI layout plus Korean IME composition still require the manual checks below.                                                                                                                                                                                                                                                                                          |

## Command ledger

| Command                                                                                                     | Result                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile --offline`                                                         | PASS; all 11 workspace projects, lockfile current, no network required.                                                                        |
| `corepack pnpm format` then `corepack pnpm format:check`                                                    | PASS; mechanically corrected the 11 baseline formatting failures and formatted new artifacts.                                                  |
| `corepack pnpm exec vitest run packages/session-runtime/src/node-pty.integration.test.ts`                   | PASS; 1 file, 4 real Windows PTY tests, including Git-bundled Vim.                                                                             |
| `corepack pnpm exec vitest run apps/vscode-extension/src/adapters/jsonl-runtime-client.integration.test.ts` | PASS; packaged sidecar and real PTY round trip.                                                                                                |
| `corepack pnpm verify`                                                                                      | PASS; Prettier, ESLint, strict typecheck, TypeScript/esbuild build, 46 files/200 tests, and dependency-cruiser (125 modules/167 dependencies). |
| `corepack pnpm test:vscode`                                                                                 | PASS; official VS Code 1.131.0 Extension Host, 1 test, exit code 0.                                                                            |
| `code --version`                                                                                            | PASS; 1.116.0 x64.                                                                                                                             |
| `Get-Command code,vim,nvim` plus Git-root derivation                                                        | `code` found; `vim` is not on PATH but Git-bundled Vim was found and passed; `nvim` NOT FOUND.                                                 |

The Extension Host emitted non-fatal upstream warnings for Chromium `cached-data` and a built-in Mermaid proposal; Honey Bee's test still passed and the host exited 0.

### Resolved red runs

- Baseline `prettier --check .` failed on 11 existing configuration/architecture files; `prettier --write` made mechanical-only formatting changes and the final gate passed.
- The first bounded-log assertion expected 10,000 contiguous `x` characters, but ConPTY correctly inserted cursor/control sequences at terminal wraps. The assertion now counts payload characters while still requiring truncation and full-log retention; the real PTY rerun passed 3/3.
- The first packaged runtime bundled node-pty's worker code into one file and hung because node-pty resolves a worker by path. The build now externalizes node-pty into `dist/runtime/node_modules` with its workers/native assets; the packaged sidecar PTY test passes.
- A full verify after downloading VS Code initially let dependency-cruiser enter `.vscode-test` and hit a stack overflow in a built-in minified extension. Source exclusions were added, and the final dependency gate passes.

## Console delivery correctness and restart recovery (2026-07-30)

### PR #1 acknowledgement and Draft race fix

The former Webview cleared Monaco immediately after posting `prompt.send`, allowing an empty `draft.changed` write to race the Provider's independent debounce even when Runtime input failed. Protocol version 2 introduced correlated request IDs, accepted/rejected acknowledgements, Session-scoped revisions, serialized Draft writes, accepted-only editor clearing, pending-submit blocking, and IME composition guards.

Protocol version 3 retains those request correlation and revision rules while reporting local durability as two typed dimensions: `receiptPersistence` and `draftCleanup`. A Runtime failure still returns `prompt.rejected` and preserves the exact Draft. Once Runtime input succeeds, later persistence failures return `prompt.accepted`; the Webview clears only the correlated submitted text and does not invite a duplicate retry.

### Stale Draft problem remaining after PR #1

PR #1 still allowed this restart sequence:

```text
Runtime sendInput succeeds
-> Draft deletion fails
-> prompt.accepted with a cleanup warning
-> VS Code restarts
-> the already-delivered persisted Draft is restored as ordinary input
```

The current implementation closes that recovery gap when a delivery Receipt was persisted before the cleanup failure.

### Receipt meaning and data minimization

A `PromptDeliveryReceipt` means only that `RuntimeClientPort.sendInput()` returned successfully. It does not prove that the PTY program consumed or understood the input, and it does not track Agent completion.

The strict version-1 Receipt stores request ID, Session ID, delivery timestamp, cleanup state, exact UTF-8 byte length, and SHA-256 digest formatted as `sha256:<lowercase-hex>`. It never stores Prompt content. Hashing performs no trim, newline conversion, or Unicode normalization. Receipt, Output Channel, warning, and reconciliation report paths contain identifiers and typed status only so Prompt bodies and embedded secrets are not copied into recovery metadata.

### Delivery and cleanup ordering

```text
validate non-empty Prompt
-> persist exact Draft
-> call Runtime sendInput exactly once
-> persist pending Receipt
-> attempt Draft deletion
-> on deletion success, update Receipt to cleared
-> prune old cleared Receipts
-> return correlated acknowledgement
```

Runtime failure creates no Receipt. Receipt save failure, Draft deletion failure, Receipt cleanup-state update failure, and retention failure remain distinct typed warnings. Receipt/Draft persistence failures after Runtime success never cause automatic resend or reclassification as rejected.

### Startup reconciliation

Reconciliation runs after Repository construction and before selected Session or Console Draft restoration.

| Receipt and Draft state                                                                                | Startup action                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| pending or cleared Receipt + same Session, digest, UTF-8 byte length, and pre-delivery Draft timestamp | Delete the stale Draft; mark a pending Receipt cleared after successful deletion. |
| pending Receipt + no Draft                                                                             | Mark the Receipt cleared.                                                         |
| cleared Receipt + no Draft                                                                             | No action.                                                                        |
| Receipt + different content or a Draft written after delivery                                          | Preserve the user Draft and resolve the old pending Receipt as cleared.           |
| invalid Receipt store or Repository operation failure                                                  | Preserve Drafts and emit an identifier-only warning; never guess or auto-delete.  |

The Reconciler has no Runtime dependency and never sends input during activation. A persisted Receipt for another Session cannot delete a Draft even when the content bytes are identical.

### Retention and shutdown

The default bounded policy retains the newest 1,000 cleared Receipts globally and prunes the oldest cleared entries first. Pending Receipts are never automatically pruned. The globalState Receipt adapter serializes save/update/delete/prune mutations within the Repository instance so parallel read-modify-write operations do not overwrite one another.

Coordinator shutdown cancels and flushes pending Draft debounce work, awaits Session write tails and active deliveries, then Extension deactivation awaits the Receipt write queue and Runtime disposal. The whole shutdown path has a five-second bound and records a generic timeout warning rather than waiting forever.

### Automated evidence

- Domain/hash tests accept strict receipts, reject invalid digest/date/state/version values, distinguish exact newline/space/Unicode bytes, verify UTF-8 byte length, and verify that the fingerprint contains no Prompt source.
- In-memory and globalState Repository tests cover round-trip CRUD, validation, deterministic request-ID update/conflict behavior, parallel saves, write-tail flush, cleared retention, and pending retention.
- Delivery tests prove `Draft save -> Runtime -> pending Receipt -> Draft delete -> cleared Receipt`, no Receipt on Runtime failure, all Receipt/Draft failure combinations, no Runtime resend, and redacted results.
- Reconciliation tests cover pending/cleared exact matches, missing Draft, different/newer Draft, cross-Session content, delete/update/store/prune failures, and fail-safe preservation.
- Restart Integration tests inject Draft cleanup failure, recreate globalState adapters, remove only the exact stale Draft, preserve a newer Draft, and observe zero additional Runtime writes.
- The VS Code Extension Host test seeds matching and newer persisted states before activation, confirms reconciliation precedes Console restore, and exposes only a sanitized Test-mode snapshot.

## Prompt Attempt journal and unknown-outcome recovery (PR #3)

### Failure remaining after persisted Receipts

PR #2 could recover when Runtime acceptance or a matching Receipt was durable, but this interval remained ambiguous:

```text
durable Draft
-> Runtime sendInput begins or succeeds
-> timeout, disconnect, response loss, or process crash
-> no durable accepted Attempt or Receipt
```

The Extension could not honestly call this rejected because input might have reached the PTY, and automatic retry could execute the Prompt twice. Protocol version 4 keeps PR #1 request correlation and PR #2 Receipt reconciliation while adding a durable pre-delivery Attempt and an explicit `prompt.unknown` outcome.

### Attempt and Receipt responsibilities

A strict version-1 `PromptDeliveryAttempt` stores request ID, Session ID, exact SHA-256 digest, UTF-8 byte length, phase, minimal timestamps, schema version, and an optional replacement request ID. It contains no Prompt content, excerpt, preview, terminal echo, or reversible encoding. The exact UTF-8 fingerprint function used by Receipts is reused without trimming, newline conversion, or Unicode normalization.

An Attempt records delivery progress and unresolved ambiguity. A Receipt still means only that `RuntimeClientPort.sendInput()` returned accepted locally; it does not prove Agent consumption, understanding, execution, or completion. “Assume delivered” is a user resolution on the Attempt and never creates a Receipt.

### Durable delivery ordering

```text
exact Draft save
-> prepared Attempt save and flush
-> dispatching Attempt save and flush
-> Runtime sendInput exactly once
-> accepted: runtime-accepted Attempt save
-> pending Receipt save
-> exact Draft cleanup
-> cleared Receipt save
-> Attempt finalization and bounded prune
```

Draft, prepared, dispatching, or pre-dispatch flush failure results in zero Runtime calls and preserves the Draft. Explicit Runtime rejection proves no PTY dispatch, preserves the Draft, creates no Receipt, and permits a normal later submit. Timeout, disconnect, response loss, or ambiguous transport write becomes `unknown`: the Draft remains, no Receipt is created, and only that Session is locked.

### Startup Attempt reconciliation

Attempt reconciliation runs before Receipt reconciliation, Session selection, Console restore, and Monaco Draft display. It has no Runtime dependency and performs zero input calls.

| Durable Attempt/evidence                         | Activation action                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `prepared`                                       | Mark cancelled-before-dispatch, preserve Draft, allow normal submit.                                                 |
| `dispatching` without matching accepted evidence | Transition to `unknown`, preserve Draft, lock only that Session.                                                     |
| `runtime-accepted` without Receipt               | Reconstruct a pending Receipt with the original `acceptedAt`; then existing exact Receipt/Draft reconciliation runs. |
| exact matching Receipt                           | Treat Receipt as authoritative local acceptance and finalize Attempt.                                                |
| conflicting Receipt identity                     | Preserve Attempt, Receipt, and Draft; emit a typed identifier-only conflict.                                         |
| `unknown`                                        | Preserve it and require explicit user resolution; never auto-resend or auto-delete its Draft.                        |

Only a same-Session, exact digest and byte-length match whose Draft timestamp is not newer is stale-cleanup eligible. A different or newer Draft and an identical Draft belonging to another Session are always preserved. Invalid stores and Repository failures fail toward preservation.

### Explicit recovery UX

The Console shows a content-free warning that Honey Bee cannot determine whether the Prompt reached the Runtime and will not resend it automatically. Ordinary submit is disabled only for the affected Session; other Sessions remain editable and deliver normally.

- **Assume delivered** records `resolved-assumed-delivered`, removes only an exact not-newer Draft, preserves newer/different Drafts, creates no Receipt, and unlocks only after the transition is stored.
- **Retry with new request ID** requires an exact Draft and modal duplicate-risk confirmation, calls the normal delivery pipeline, and never reuses the original request ID. The original becomes `resolved-retried` only after replacement acceptance. Rejected or unknown replacement delivery leaves the original unresolved; a replacement unknown remains queued.
- Closing or duplicating an action does not resolve the Attempt. Recovery actions are Session-serialized, stale/cross-Session actions are ignored, and late duplicate actions are idempotent.

Status, notifications, stored recovery metadata, and Output Channel diagnostics contain only typed codes, phases, Session IDs, request IDs, timestamps, and match state—not Prompt source or raw transport payload.

### Attempt retention and shutdown

The default policy keeps the newest 1,000 terminal Attempts globally. Active `prepared`, `dispatching`, `runtime-accepted`, and `unknown` entries are never automatically pruned. The `globalState` Repository validates strict stored data, rejects identity mutation and reverse transitions, serializes writes, and exposes a write-tail `flush()`.

The five-second bounded shutdown now awaits pending Draft debounce/write tails, active delivery and recovery work, Attempt and Receipt write tails, reconciliation mutations, and Runtime disposal. Timeout remains non-blocking and is diagnosed without Prompt content.

### Automated evidence added for PR #3

- Domain tests cover strict phase fields, digest/length validation, replacement identity, allowed/rejected transitions, and immutable Attempt identity.
- In-memory and `globalState` tests cover CRUD/recreation, invalid-store preservation, concurrent-save serialization, monotonic transitions, terminal-only retention, content minimization, and write-tail flush.
- Deterministic delivery failpoints cover Draft/prepared/dispatching failures with zero Runtime writes, explicit rejection, timeout/disconnect unknown, accepted ordering, Receipt-authoritative fallback, missing-Receipt reconstruction, and accepted/Receipt dual persistence failure.
- Startup tests cover prepared cancellation, dispatching-to-unknown, runtime-accepted Receipt reconstruction using `acceptedAt`, exact/conflicting Receipts, exact stale cleanup, newer Draft preservation, and zero Runtime dependency.
- Recovery tests cover exact-only Assume delivered cleanup, no synthesized Receipt, fresh-ID retry through the normal pipeline, duplicate action serialization, nested replacement unknown outcomes, and stale/cross-Session action safety.
- Protocol, Console, Integration, and Extension Host fixtures cover protocol v4, `prompt.unknown`, Session-local submit lock, another Session remaining usable, persisted dispatching activation, runtime-accepted Receipt reconstruction, Draft preservation, and zero startup Runtime writes.

### Remaining uncertainty and manual validation

End-to-end exactly-once delivery is still not claimed. After `dispatching` is durably flushed, the Runtime may write the input and the process may die before `runtime-accepted` or a Receipt is durable. Restart now represents that interval as persisted `unknown` instead of silently rejecting or resending it, but only the user or a future transactional Runtime protocol can resolve it. A Runtime accepted response still stops at the PTY write API.

Actual Windows storage outage behavior, interactive crash timing, rendered recovery UX, and Korean IME remain manual. Monaco composition guards and key policy have automated coverage, but a human must verify composition/focus across unknown/pending states.

## Runtime lifecycle and stale Session recovery (PR #4)

### Ephemeral Runtime and Run identity

Honey Bee v0.x starts a new sidecar Runtime for each Extension activation. Protocol version 2 adds a `runtime.hello` handshake with `runtimeInstanceId` and PID, and every Session execution receives a fresh `runId`. Start, input, resize, interrupt, stop, snapshot, PTY data, and PTY exit are Run-scoped. A strict `SessionRunRecord` persists only Session/Run/Runtime identity, phase, timestamps, termination reason, optional exit code, and schema version; it contains no Prompt, terminal output, environment, command arguments, secret, or raw packet.

`AgentSession.status` remains a current UI projection. Session Run persistence establishes ownership and terminal history. Same-Session status updates are serialized; different Sessions remain independent. Events from an older Run are ignored before both Repository and UI mutation, and duplicate terminal events are idempotent.

### Shutdown ownership and ordering

`ExtensionLifecycleCoordinator` is the single idempotent owner shared by context disposal, `deactivate()`, and activation-failure cleanup. Its bounded order is:

```text
close mutation gate
-> drain active Prompt delivery/recovery and Draft writes
-> persist active Runs as stopping
-> Runtime graceful shutdown and per-PTY final events
-> flush status queues plus Run/Attempt/Receipt tails
-> dispose Runtime transport and listeners
```

The Runtime `shutdown()` request and transport `dispose()` are separate. Clean shutdown maps Runs to `stopped` with `extension-shutdown`, not Agent failure. The total deadline is five seconds; timeout marks remaining current Runs `interrupted/shutdown-timeout`, attempts bounded hard disposal, reports unresolved work, and returns without hanging. Diagnostics contain safe codes and Session/Run identifiers only.

The Runtime rejects new work after shutdown starts. stdin EOF invokes the same idempotent, best-effort PTY cleanup. Each Session is attempted independently, so one stop failure does not prevent the remaining stops. Windows `node-pty` kill does not provide a native Job Object process-tree guarantee; unresolved descendants after a hard host/OS kill remain a documented risk.

### Startup stale recovery

Prompt Attempt and Receipt reconciliation still runs first. Before Session selection, Console Draft restoration, or any Agent start, active Run reconciliation applies this table:

| Persisted state                                                                         | Activation result                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Run `starting`, `running`, `waiting-for-input`, or `stopping` from the previous Runtime | Session `stopped`; Run `interrupted/recovered-stale-run`                                   |
| legacy active Session status without Run record                                         | Session `stopped`; no invented Run                                                         |
| invalid Run store plus active Session status                                            | Run store preserved; Session fails safe to `stopped`; identifier-only warning              |
| terminal Session or Run                                                                 | unchanged                                                                                  |
| persisted unknown Prompt plus stale Run                                                 | stale Run recovered; Draft and unknown issue preserved; same-Session submit lock preserved |

Activation starts zero Agent processes and sends zero Prompt inputs. Honey Bee never automatically restarts stale Sessions. The Console reports that the previous Runtime ended and leaves manual Start available once independent Prompt recovery locks permit it.

### Termination meaning

- exit 0 is `completed/process-exit-zero`;
- nonzero exit is `failed/process-exit-nonzero`;
- user stop or interrupt is `stopped/user-stop`;
- graceful Extension or Runtime shutdown is `stopped/extension-shutdown` or `stopped/runtime-shutdown`;
- unexpected Runtime disconnect interrupts only current active Runs with `runtime-disconnected`;
- stale activation recovery uses `recovered-stale-run` and is not Agent failure.

### Automated evidence added for PR #4

- Domain and in-memory/globalState tests cover strict Run schema, phase fields, identity immutability, transition policy, active conflict, concurrent serialized saves, invalid-store preservation, write-tail flush, and content minimization.
- Controller tests cover durable `starting` before the Runtime call, fresh Run identity, start failure, same-Session serialization, Run A late-event rejection after Run B, terminal idempotency, mutation gating, and identifier-only diagnostics.
- Lifecycle tests cover two active Runs, one shared shutdown Promise across disposal entry points, exact drain/stop/flush/dispose ordering, and a non-returning Runtime shutdown bounded by hard cleanup.
- Runtime protocol/server tests cover hello identity, Run-scoped actions/events, stale action rejection, shutdown request gating, per-Session PTY cleanup, final status, and stdin EOF.
- Startup tests recover every active phase and legacy status, preserve invalid Run data, preserve Prompt unknown recovery, and perform zero Runtime starts or Prompt sends.
- Packaged Runtime, Korean path, real Windows ConPTY, interrupt, immediate exit, and Git-bundled Vim tests retain their prior end-to-end coverage under protocol v2.

### Manual lifecycle validation still required

A human-observable Extension Development Host must still verify Reload Window, forced Extension Host termination, external Runtime PID termination, process inspection after graceful shutdown, recovery notification accessibility, Korean IME composition/focus, and Neovim. Automated tests do not substitute for these OS/UI observations.

## Manual GUI, IME, and Neovim checklist

Run these on a Windows 11 workstation with a human-observable Extension Development Host. Record screenshots or a short capture and the exact VS Code/Neovim versions. Git-bundled Vim already has automated ConPTY coverage.

1. Run `corepack pnpm build`, then `code --new-window --extensionDevelopmentPath=apps/vscode-extension .`.
2. Confirm the Honey Bee activity-bar icon, Sessions tree, Console webview, header metadata, connection badge, and Start/Interrupt/Stop controls render without clipping at 100%, 125%, and 150% scaling.
3. Create, rename, tag, parent, relate, and delete sessions; reload the host and confirm the selected Session and each session's draft restore. Corrupt/delete the stored selection target and confirm the UI safely falls back to no selection.
4. Configure Echo Fixture as the agent, start it, and confirm ANSI colors, `Honey Bee Echo 벌 🐝`, literal input, resize/reflow, non-zero exit, and interrupt are visible in xterm.
5. Verify Enter and Ctrl+Enter submit; Shift+Enter and Alt+Enter insert a newline. Compose Korean text with the Windows IME and confirm intermediate composition does not submit or duplicate characters.
6. Switch repeatedly between two sessions and confirm draft text and console output remain associated with the correct Session.
7. Force Runtime input failure with a non-empty Draft and confirm `prompt.rejected`, preserved editor text, restored focus, and an accessible status error. Then inject Draft cleanup failure after a successful write and confirm `prompt.accepted`, a pending Receipt, no retry invitation, and automatic exact-Draft cleanup after restart. Inject a Receipt-store outage separately and confirm Runtime success is not reclassified while recovery uncertainty is clearly warned.
8. Exercise the Attempt kill points immediately after prepared persistence, dispatching persistence, Runtime acceptance, before Receipt persistence, and after Receipt persistence but before Attempt finalization. Confirm prepared permits a normal retry, dispatching becomes unknown with zero startup writes, runtime-accepted reconstructs its Receipt, same-Session submit stays locked, Assume delivered creates no Receipt, Retry uses a fresh ID, and another Session remains usable.
9. Optionally inspect Git-bundled Vim interactively beyond its passing automated smoke. Install Neovim (`nvim`), repeat insert/normal mode, arrow/function keys, resize, `:q`, and Ctrl+C through the PTY, and record any ConPTY escape-sequence differences.

## Remaining risks and intentional limits

- Visual layout, accessibility focus order, screen-reader behavior, Korean IME composition, and Neovim behavior are BLOCKED in this environment; no automated success is substituted. Git-bundled Vim is PASS through the real ConPTY smoke.
- Protocol v4 durably journals Attempt identity before Runtime dispatch. A crash after durable `dispatching` but before `runtime-accepted` or Receipt persistence is now recovered as a Session-local `unknown`; it remains inherently ambiguous, is never auto-retried, and does not establish exactly-once delivery.
- No signed/installed VSIX was produced. The built `dist` layout and native packaged runtime were executed in both Vitest and the official development Extension Host; Marketplace/VSIX installation remains release validation.
- Source-size debt remains: `jsonl-runtime-client.ts` is 558 lines, `console-service.ts` 474, `webview/console.ts` 394, `session-commands.ts` 335, and `extension.ts` 324. The Runtime client and Console service should be split along transport and recovery-orchestration boundaries before further lifecycle expansion.
- The UI exposes bounded in-memory output but no explicit truncation marker. The PTY file log retains the full output; a future UI should surface truncation state.
- The generated packaged runtime is 6,895,824 bytes across 56 files after excluding PDB debug symbols and includes Windows x64 and arm64 assets only, consistent with the Windows-first decision.
- Actual Git worktree, Library copy, ReFS/COW, Unity CLI operations, and production tool integrations are intentionally outside this vertical slice; only their package boundaries/contracts exist.
