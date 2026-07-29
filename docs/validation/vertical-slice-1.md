# Vertical Slice 1 validation

Date: 2026-07-29 (Asia/Seoul)

## Outcome

The automated Windows vertical slice is green: repository quality gates, architecture rules, strict typechecks, both esbuild bundles, 64 Vitest cases, a real packaged-runtime PTY round trip, the Git for Windows bundled Vim TUI smoke, and the official VS Code Extension Host smoke test passed. Eleven cases in the required matrix are PASS; the visual/IME/Neovim case is BLOCKED and is deliberately not counted as a pass.

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

| ID    | Status  | Scope and evidence                                                                                                                                                                                                                                                                                                           |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS-01 | PASS    | Root formatting, ESLint, strict package typechecks, build, tests, and dependency-cruiser run from `corepack pnpm verify`; 81 source modules and 84 dependencies had no violations. Generated `dist`, `.vscode-test`, coverage, and runtime-state directories are explicitly excluded from architecture analysis.             |
| VS-02 | PASS    | Domain/persistence tests cover session creation, tag rules, parent/related integrity, cycle/self-reference rejection, CRUD, query ordering, and delete detachment: `packages/domain`, `packages/persistence`, and extension application tests all passed.                                                                    |
| VS-03 | PASS    | `GlobalStateSessionRepository`, per-session drafts, and selected Session ID survive new repository instances. Missing or schema-invalid selected IDs are cleared and fall back to no selection; draft `session-2` restores as `second`.                                                                                      |
| VS-04 | PASS    | The default runtime is built into `apps/vscode-extension/dist/runtime/cli.cjs`, resolved from the absolute extension root, and packaged with node-pty workers, license, and Windows x64/arm64 native assets. Explicit command and argv (including quotes, metacharacters, spaces, and Korean) remain separate and unchanged. |
| VS-05 | PASS    | `CustomCommandAgentAdapter` normalizes `C:\프로젝트 파일\Hive (A)\child\..\worktree`, preserves `literal "quote" & \| ^ %PATH%` as one argv item, merges the Windows environment case-insensitively, and keeps `shell: false`.                                                                                               |
| VS-06 | PASS    | JSONL tests cover fragmented/multiple lines, malformed JSON, strict schemas, correlated typed errors, request timeout/exit behavior, and separation of protocol-only stdout from diagnostic stderr.                                                                                                                          |
| VS-07 | PASS    | Real Windows ConPTY launches a copied Echo Fixture from `Honey Bee 한글 PTY ...\도구 경로 (공백)\Echo 벌 Fixture.js`; greeting, ANSI, UTF-8 `한글`/bee emoji, resize, literal metacharacters, exit 7, and full log all passed.                                                                                               |
| VS-08 | PASS    | A 10,000-character Echo Fixture burst causes the 4,096-byte in-memory ring snapshot to report truncation while the full PTY log retains at least 10,000 payload characters; terminal control sequences are allowed between rendered runs.                                                                                    |
| VS-09 | PASS    | Real PTY tests cover natural non-zero exit 7, immediate exit 9, and Ctrl+C interrupt with `INTERRUPTED`, exit code 130, `reason: interrupted`, and zero active sessions afterward; unit tests retain stop/force-kill coverage.                                                                                               |
| VS-10 | PASS    | The extension JSONL client starts the packaged sidecar from an unrelated temporary cwd, launches Echo Fixture, resizes, sends ANSI input, observes successful PTY exit, and keeps diagnostics protocol-clean.                                                                                                                |
| VS-11 | PASS    | esbuild produced the webview JS/CSS, `extension.cjs`, and packaged runtime; `@vscode/test-cli`/`@vscode/test-electron` launched VS Code 1.131.0, activated `honeybee.honey-bee-vscode`, found all 13 public commands, executed refresh, and exited 0.                                                                        |
| VS-12 | BLOCKED | Git for Windows bundled Vim passed a real 100x30 ConPTY smoke with ANSI and alternate-screen output, `-Nu NONE -n -i NONE`, `Esc :q!`, exit code 0, and no active session afterward. Neovim is absent, and rendered GUI layout plus Korean IME composition still require the manual checks below.                            |

## Command ledger

| Command                                                                                                     | Result                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile --offline`                                                         | PASS; all 11 workspace projects, lockfile current, no network required.                                                                     |
| `corepack pnpm format` then `corepack pnpm format:check`                                                    | PASS; mechanically corrected the 11 baseline formatting failures and formatted new artifacts.                                               |
| `corepack pnpm exec vitest run packages/session-runtime/src/node-pty.integration.test.ts`                   | PASS; 1 file, 4 real Windows PTY tests, including Git-bundled Vim.                                                                          |
| `corepack pnpm exec vitest run apps/vscode-extension/src/adapters/jsonl-runtime-client.integration.test.ts` | PASS; packaged sidecar and real PTY round trip.                                                                                             |
| `corepack pnpm verify`                                                                                      | PASS; Prettier, ESLint, strict typecheck, TypeScript/esbuild build, 23 files/64 tests, and dependency-cruiser (81 modules/84 dependencies). |
| `corepack pnpm test:vscode`                                                                                 | PASS; official VS Code 1.131.0 Extension Host, 1 test, exit code 0.                                                                         |
| `code --version`                                                                                            | PASS; 1.116.0 x64.                                                                                                                          |
| `Get-Command code,vim,nvim` plus Git-root derivation                                                        | `code` found; `vim` is not on PATH but Git-bundled Vim was found and passed; `nvim` NOT FOUND.                                              |

The Extension Host emitted non-fatal upstream warnings for Chromium `cached-data` and a built-in Mermaid proposal; Honey Bee's test still passed and the host exited 0.

### Resolved red runs

- Baseline `prettier --check .` failed on 11 existing configuration/architecture files; `prettier --write` made mechanical-only formatting changes and the final gate passed.
- The first bounded-log assertion expected 10,000 contiguous `x` characters, but ConPTY correctly inserted cursor/control sequences at terminal wraps. The assertion now counts payload characters while still requiring truncation and full-log retention; the real PTY rerun passed 3/3.
- The first packaged runtime bundled node-pty's worker code into one file and hung because node-pty resolves a worker by path. The build now externalizes node-pty into `dist/runtime/node_modules` with its workers/native assets; the packaged sidecar PTY test passes.
- A full verify after downloading VS Code initially let dependency-cruiser enter `.vscode-test` and hit a stack overflow in a built-in minified extension. Source exclusions were added, and the final dependency gate passes.

## Manual GUI, IME, and Neovim checklist

Run these on a Windows 11 workstation with a human-observable Extension Development Host. Record screenshots or a short capture and the exact VS Code/Neovim versions. Git-bundled Vim already has automated ConPTY coverage.

1. Run `corepack pnpm build`, then `code --new-window --extensionDevelopmentPath=apps/vscode-extension .`.
2. Confirm the Honey Bee activity-bar icon, Sessions tree, Console webview, header metadata, connection badge, and Start/Interrupt/Stop controls render without clipping at 100%, 125%, and 150% scaling.
3. Create, rename, tag, parent, relate, and delete sessions; reload the host and confirm the selected Session and each session's draft restore. Corrupt/delete the stored selection target and confirm the UI safely falls back to no selection.
4. Configure Echo Fixture as the agent, start it, and confirm ANSI colors, `Honey Bee Echo 벌 🐝`, literal input, resize/reflow, non-zero exit, and interrupt are visible in xterm.
5. Verify Enter and Ctrl+Enter submit; Shift+Enter and Alt+Enter insert a newline. Compose Korean text with the Windows IME and confirm intermediate composition does not submit or duplicate characters.
6. Switch repeatedly between two sessions and confirm draft text and console output remain associated with the correct Session.
7. Force runtime input failure while a non-empty draft exists and confirm whether the editor preserves it. This is a known risk because the webview currently clears optimistically before an extension-confirmed success acknowledgement.
8. Optionally inspect Git-bundled Vim interactively beyond its passing automated smoke. Install Neovim (`nvim`), repeat insert/normal mode, arrow/function keys, resize, `:q`, and Ctrl+C through the PTY, and record any ConPTY escape-sequence differences.

## Remaining risks and intentional limits

- Visual layout, accessibility focus order, screen-reader behavior, Korean IME composition, and Neovim behavior are BLOCKED in this environment; no automated success is substituted. Git-bundled Vim is PASS through the real ConPTY smoke.
- The webview clears its local prompt immediately on send, while the application service deletes the persisted draft only after runtime success. Without a success/failure acknowledgement back to the webview, a failed send can still appear to lose the local draft; this needs a protocol/UI follow-up and failure-preserves-draft test.
- No signed/installed VSIX was produced. The built `dist` layout and native packaged runtime were executed in both Vitest and the official development Extension Host; Marketplace/VSIX installation remains release validation.
- Source-size debt remains: `jsonl-runtime-client.ts` is 490 lines, `console-service.ts` 353, `session-commands.ts` 335, and `server.ts` 303. The 490-line client especially combines transport, decoding, and orchestration and should be split before expansion.
- The UI exposes bounded in-memory output but no explicit truncation marker. The PTY file log retains the full output; a future UI should surface truncation state.
- The generated packaged runtime is 6,895,824 bytes across 56 files after excluding PDB debug symbols and includes Windows x64 and arm64 assets only, consistent with the Windows-first decision.
- Actual Git worktree, Library copy, ReFS/COW, Unity CLI operations, and production tool integrations are intentionally outside this vertical slice; only their package boundaries/contracts exist.
