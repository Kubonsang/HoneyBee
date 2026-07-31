# ADR-012: Retained Run navigation and degraded replay

- Status: Accepted
- Date: 2026-07-31

## Context

ADR-011 isolated every xterm surface and bounded transcript by `sessionId + runId`, but the Console still exposed only one automatically chosen Run through `ConsoleViewState.selectedRun`. Users could not navigate to an already-retained Run, and the UI did not consistently explain whether a visible screen was live, read-only, reconstructed, truncated, missing sequence data, or unavailable after memory eviction.

Run metadata, an xterm surface, a bounded transcript, and a Runtime log have different lifetimes. Treating them as one `available` flag would overstate replay correctness and could invite input against the wrong active Run.

## Decision

Console Webview protocol v7 separates the Session's current `activeRun` from the user's `viewedRun`. `followLive` records whether a future active Run may become the viewed Run automatically.

On first Session selection, an active Run is viewed and followed. Without an active Run, the most recent Run is viewed. Selecting an archived Run disables follow-live. A new Run only takes the view when follow-live remains enabled or the user explicitly starts it. When an active Run exists elsewhere, the Console displays **Live Run available** and a **Return to live** button.

### Metadata and availability ownership

`SessionRunRepository` is authoritative for content-free Run metadata. The Console requests a maximum of 50 recent Runs per Session, sorted with the active Run first and then by descending start time with Run ID as a stable tie-break. The active and viewed Runs are always retained in this projection.

Availability remains intentionally split:

- `SessionRunRecord` says that the Run existed and how it ended;
- `RunOutputBufferStore` says whether bounded raw ANSI remains, whether bytes were truncated, and whether a sequence gap occurred;
- `TerminalRunRegistry` alone knows whether an xterm surface is still alive in the Webview;
- `SessionRunController` temporarily correlates the Runtime-origin log path for the current Runtime generation.

Run metadata retention does not imply that a surface, transcript, or log still exists.

### Accessible selector and lazy surfaces

The Console header uses a labelled native `<select>` named **Terminal run**. Native keyboard behavior is preferred over a custom listbox. Options include a short Run ID, live/terminal state, human-readable termination meaning, and start time. The full Run ID is available as option metadata without exposing terminal content.

Rendering the metadata list does not create xterm instances. The existing surface is shown when retained. Otherwise, selecting a Run lazily creates a read-only surface only when a bounded transcript is available. A metadata-only selection shows an explicit placeholder. Selection never calls the Runtime and never mutates the Run repository.

A concise polite live region announces the newly viewed Run, read-only/live state, and replay quality. Terminal output is never copied into an alert or live region. Status uses text and semantic controls, not color alone, and new styles use VS Code theme and forced-color values.

### Mutation safety

Prompt send, terminal input, resize, interrupt, and stop are enabled only when `viewedRun` exactly equals the current interactive `activeRun`, the Runtime is connected, and the Extension lifecycle is active. Archived Runs remain selectable, copyable, scrollable, and eligible for log opening, but are read-only.

The Extension validates Session ownership and Run existence again. Stale, cross-Session, and old-protocol actions fail closed and perform zero Runtime mutation. Returning to live is an explicit content-free view action.

### Replay language

Protocol v7 exposes these distinct states:

- `live`: the current interactive surface;
- `retained-complete`: reconstructed from the complete bounded in-memory transcript;
- `retained-truncated`: earlier bytes were evicted and reconstruction may be incomplete;
- `sequence-gap`: one or more output events were missed and reconstruction may be inconsistent;
- `surface-only`: the retained emulator is still useful, but its transcript cannot reconstruct it after Webview loss;
- `metadata-only`: no surface or transcript is retained.

Raw ANSI replay is never described as a serialized or byte-perfect emulator snapshot. A retained surface can remain more complete than its truncated transcript; it is therefore shown as surface-only rather than falsely warning that the currently visible emulator was reconstructed from the truncated prefix.

### Open Log security and privacy

The Webview sends only `sessionId + runId`. It never supplies a path. The Extension re-reads Run ownership and accepts only the Runtime-origin path correlated to that exact Run in the current Runtime generation. It checks existence, rejects directories, warns before opening files larger than 10 MiB, and opens through the VS Code TextDocument API. Missing, binary, inaccessible, or stale paths fail safely without logging file contents.

Only `logAvailable` crosses into Webview state. Local paths, terminal bodies, raw ANSI, xterm state, Prompts, clipboard data, and log contents are not added to `globalState`, DOM state, Output Channel diagnostics, or telemetry.

### Bounded memory

The ADR-011 limits remain unchanged: 512 KiB per transcript, a 6 MiB total target, 12 terminal transcripts, and 8 xterm surfaces. Active and viewed resources are protected by their respective stores. The 50-item metadata list is independent and does not allocate 50 terminals.

### Console Vertical Slice boundary

This decision closes feature expansion for the Session Console Vertical Slice. Further work should move to Agent/Tool Profile registry or Local Core/Workspace boundaries rather than adding a full history page, terminal search, transcript export, split panes, or durable emulator serialization here.

## Consequences

### Positive

- Users can identify and navigate every retained Run without confusing it with the current Runtime Run.
- Archived inspection cannot accidentally stop, interrupt, resize, type into, or submit a Prompt to the active Run.
- Replay limitations and memory eviction are visible and accessible.
- Metadata-only Runs remain useful and can open an authoritative log when one is still known.
- Selector rendering is bounded and does not multiply xterm instances.
- No new dependency, terminal persistence, telemetry, or local-path disclosure is introduced.

### Costs and limitations

- Viewed/follow-live preference is Extension memory only and resets to active/latest after activation.
- A Runtime log path is intentionally unavailable after a new ephemeral Runtime generation unless future durable metadata explicitly models it.
- Raw ANSI replay still cannot recreate missing or truncated bytes or every emulator mode.
- Browser-native select rendering varies by VS Code platform and theme.
- Narrator, 200% zoom, high-contrast, Korean IME, and interactive Vim/Neovim behavior still require human validation.

## Alternatives considered

### Custom Run history dropdown

Rejected for the vertical slice. It would add keyboard, focus, listbox, virtualization, and screen-reader complexity without improving the core model.

### Persist viewed Run and terminal availability

Rejected. View preference does not justify global persistence, and terminal availability is process-local. Persisting it would create stale claims after Webview or Extension loss.

### Send log paths to the Webview

Rejected because the Webview is not the authority for filesystem access and paths can disclose usernames and workspace layout or be tampered with.

### Create all retained surfaces eagerly

Rejected because the 50-item metadata cap is intentionally separate from the 8-surface memory cap.

## Related decisions

- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-010](ADR-010-runtime-lifecycle-and-stale-session-recovery.md)
- [ADR-011](ADR-011-run-scoped-terminal-surfaces.md)
