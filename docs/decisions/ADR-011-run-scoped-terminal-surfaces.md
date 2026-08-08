# ADR-011: Isolate terminal emulator surfaces by Session Run

- Status: Retired — VS Code Extension removed by ADR-013
- Date: 2026-07-31
- Navigation projection: Superseded by ADR-012; Run isolation and retention remain current

## Context

ADR-010 made Runtime ownership and every PTY operation correlate to a fresh `runId`, but the Console presentation still collapsed that identity. The Extension stored output in `Map<SessionId, string>`, protocol v5 removed Runtime sequence numbers, terminal input and resize carried only a Session ID, and the Webview reused one xterm instance for every Session and Run.

Selecting another Session called `clear()` and replayed a plain string into that shared emulator. `clear()` is a scrollback operation, not a contract that resets every VT mode. A Vim/Neovim Run can leave the alternate buffer, cursor visibility/style, application cursor keys, keypad, bracketed paste, mouse tracking, focus reporting, character set, title, attributes, selection, and scroll position in xterm state. Replaying another Session into the same instance can therefore leak state. The same Session starting Run 2 could also receive Run 1 output or a stale Webview input because Session identity alone was still accepted.

Runtime protocol v2 already provides ordered `seq` values on PTY start, data, and exit. The loss occurred between the Extension application service and the Webview.

## Decision

Terminal identity is the composite `sessionId + runId`. Console Webview protocol v6 requires that identity on terminal open, data, reset, close, snapshot, input, resize, interrupt, and stop messages. Legacy Session-only terminal messages fail closed.

### One emulator per Run

`TerminalRunRegistry` owns a separate xterm 5.5.0 instance, FitAddon 0.10.0 instance, and DOM container for each retained Run. Selecting a Run shows its existing container and hides the previous one. Selection does not call xterm `clear()` or `reset()` and does not reconstruct a live surface from text.

This preserves xterm's own normal/alternate buffers, cursor, VT modes, scroll position, and selection while switching Sessions. A new Run always creates a new Terminal instance, even when its Session ID matches a previous Run. An explicit Run reset affects only that exact surface.

Hidden or archived surfaces may be viewed, selected, copied, and scrolled, but only the selected current interactive Run may emit Runtime input. Only the visible selected mutable Run is fitted and resized. Every input, resize, interrupt, and stop is checked again by the Extension against the selected active Run before reaching the Runtime. Stale actions cause identifier-only diagnostics and zero Runtime mutation.

### Run projection and ordering

`ConsoleViewState.selectedRun` is the authoritative presentation projection. The Webview does not infer Run ownership from scalar Session status. It contains Run and Session IDs, phase, interactivity, start time, and optional termination reason.

Run data carries its original Runtime sequence. A surface ignores duplicate or lower sequences. A gap produces a safe diagnostic and requests a bounded snapshot. The snapshot replaces that Run's surface with raw ANSI replay; it never switches the selected Run. A late snapshot for another Run stays hidden. Run close makes the surface read-only and records the final sequence.

The Extension buffers output by globally unique Run ID. Late data for a non-current Run is rejected before buffer or UI mutation, so Run A cannot write into Run B. Non-selected current Runs still update their own buffer and any already-created hidden surface.

### Bounded memory

Terminal bodies remain memory-only. The initial policy is:

- at most 512 KiB of UTF-8 transcript per Run;
- a 6 MiB Console transcript target across Runs;
- up to 12 terminal Run transcripts;
- up to 8 terminal xterm surfaces;
- active Runs are not evicted;
- the selected Run is not evicted;
- oldest unselected terminal Runs are evicted first.

A workload with only protected active/selected Runs may temporarily exceed the total target and emits a content-free limit diagnostic. Per-Run truncation remains enforced. Evicting an emulator does not delete the Runtime log file. Selecting an evicted Run creates a new surface from the bounded transcript if available.

### Replay is not an emulator snapshot

Raw ANSI replay is best effort. It can recreate a useful screen when the complete relevant stream is retained, but it is not a serialized xterm state. If the beginning was truncated, a sequence gap occurred, or the Webview process was destroyed, byte-perfect Vim/Neovim reconstruction is not claimed. Protocol replay includes first/last sequence and truncated byte count, and the Console displays a degraded-replay warning.

`retainContextWhenHidden` preserves surfaces for normal View hide/show and Session switching. Extension Host restart, Reload Window, or Webview process loss destroys in-memory emulator state. The Extension may replay its bounded transcript, but no terminal body or xterm serialization is persisted.

### Privacy

The following remain memory-only:

- PTY terminal output and raw ANSI;
- xterm buffers and modes;
- Vim/Neovim screen contents;
- scroll position and selection;
- clipboard content.

No terminal body, serialized emulator, command contents, Prompt, or clipboard data is added to VS Code `globalState`. Durable `SessionRunRecord` continues to contain only identifiers, lifecycle phase, timestamps, reason, and exit code. Diagnostics may contain Session ID, Run ID, sequence, byte counts, truncation, and safe codes, never terminal data or raw transport payload.

## Consequences

### Positive

- Session A and Session B cannot share xterm alternate-screen or VT mode state.
- Run 1 and Run 2 of one Session always use distinct emulators and transcripts.
- Session switching preserves live TUI screen, cursor, and scroll state without replay.
- Late Run data and stale input/resize cannot mutate the current Run.
- Memory and retained xterm counts are bounded without evicting active or selected Runs.
- No new xterm addon, production dependency, license, or persistent terminal-content store is introduced.

### Costs and limitations

- Multiple retained xterm instances consume more memory than a singleton.
- Evicted surfaces require raw replay and can lose exact TUI state after truncation.
- Sequence detection identifies loss but cannot manufacture missing bytes.
- Retained Run navigation was subsequently implemented by ADR-012; a full unbounded history page remains outside the Console Vertical Slice.
- Reload Window cannot preserve byte-perfect emulator state.
- Windows ConPTY and PTY process cleanup limits from ADR-010 are unchanged.

## Alternatives considered

### Keep one xterm and call reset

Rejected because Session switching would destroy the previous TUI screen and scroll position, while reconstructing every mode from partial output remains unreliable.

### Serialize every xterm surface

Deferred. It adds an addon, bundle cost, version-coupled state, privacy review, and still cannot guarantee correctness from truncated input. Separate live Terminal instances solve the current Session-switch problem directly.

### Persist terminal bodies or HTML snapshots

Rejected for this PR because command output may contain secrets and project content. Durable terminal history requires an explicit retention, encryption, deletion, and access policy.

### Use tmux or a Local Core

Deferred. A future long-lived Core could own durable PTY scrollback or authenticated terminal snapshots independently of the Webview. It does not change the need for Run identity and stale-action rejection.

## Related decisions

- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-010](ADR-010-runtime-lifecycle-and-stale-session-recovery.md)
