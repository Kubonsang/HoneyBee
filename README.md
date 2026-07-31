# Honey Bee

Honey Bee is a Windows-first VS Code vertical slice for managing AI-agent sessions and streaming each agent through a real PTY console. The current slice keeps the VS Code extension, JSONL runtime sidecar, domain contracts, persistence, agent adapter, and webview bundle in one pnpm workspace.

## Requirements

- Windows 11 (ConPTY is required for the end-to-end runtime tests)
- Node.js 24 or newer with Corepack
- VS Code 1.96 or newer
- Git for Windows (its bundled Vim is exercised by the PTY integration test when available)

## Install and build

From a PowerShell prompt in the repository root:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm security:install-hooks
corepack pnpm build
```

The build compiles the packages, bundles the extension and webview with esbuild, and packages the Windows PTY sidecar plus x64/arm64 native assets under `apps/vscode-extension/dist/runtime`.

## Run the extension

Open an Extension Development Host with the repository as its workspace:

```powershell
code --new-window --extensionDevelopmentPath=apps/vscode-extension .
```

Open the Honey Bee activity-bar view, create a session, select it, then use **Start Agent**. By default, the extension resolves its packaged `dist/runtime/cli.cjs` to an absolute path and launches it with `node`, so it also works when the opened Unity workspace is outside this repository. Explicit runtime command/argument overrides, agent command/arguments, and profiles can be changed under the `honeyBee.*` VS Code settings.

For a deterministic console smoke test, point `honeyBee.agent.command` to `node` and set `honeyBee.agent.args` to the absolute path of `packages/test-fixtures/dist/echo-cli.js`. Echo Fixture accepts `unicode`, `ansi`, `burst 10000`, `exit 7`, and `quit`; arbitrary input is echoed literally.

## Session process recovery

Honey Bee restores Session metadata and Drafts. It does not automatically restart Agent processes after an Extension Runtime restart. A Session that belonged to a previous ephemeral Runtime is shown as stopped, with its prior Run recorded as interrupted, so the user can decide when to start a new Run.

A normal Extension shutdown first rejects new Runtime mutations, drains Prompt durability work, asks the Runtime to stop active PTYs, persists final Run status, and then disposes the transport. Cleanup is bounded; Windows process-tree termination remains best effort without a native Job Object helper.

## Run-scoped terminal screens

Each Agent Run owns a separate in-memory xterm surface. Switching Sessions hides and shows those surfaces without clearing or replaying the live emulator, so Vim alternate-screen, cursor modes, selection, and scroll position do not leak between Sessions. Starting a new Run for the same Session creates a fresh terminal. Terminal input, resize, interrupt, and stop are accepted only for the selected current Run.

Terminal transcripts and emulator state are not stored in VS Code `globalState`. Normal View hide/show uses `retainContextWhenHidden` and preserves the live surface. Reload Window or Webview/Extension Host destruction can only use bounded raw ANSI replay; if it was truncated, Honey Bee warns that exact TUI reconstruction is unavailable.

## Quality and tests

```powershell
corepack pnpm verify
corepack pnpm test:vscode
```

`verify` runs the public-source secret scan, production license allowlist,
formatting, ESLint, strict package typechecks, both esbuild/TypeScript builds,
Vitest (including Windows ConPTY and Git-bundled Vim TUI integration), and
dependency-cruiser architecture rules. The Vim test derives the Git
installation root from the installed `git.exe`, runs `usr/bin/vim.exe` when
present, and skips only when unavailable. `test:vscode` additionally
downloads/launches an official VS Code test host and checks extension
activation and command registration.

## Security and public-source policy

The original SRS and technical-architecture DOCX files are private source
references and are intentionally excluded from Git. Runtime logs, SQLite
state, build output, environment files, registry credentials, private keys,
and common credential files are also blocked by `.gitignore` and the security
scanner.

Before committing, run `corepack pnpm security:install-hooks` once per clone.
The pre-commit hook scans the exact staged content and rejects forbidden paths,
known token/key formats, and unexpectedly large files. `corepack pnpm
security:scan` scans all tracked and unignored files. GitHub Actions repeats
the checks, and the public repository uses GitHub secret scanning with push
protection. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Honey Bee is available under the [MIT License](LICENSE). Production dependency
licenses are allowlisted and checked from the lockfile-installed graph. Full
license texts and generated legal notices are copied into extension build
artifacts; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The implementation intentionally stops at the vertical-slice boundary: no Git worktree/copy-on-write storage driver, production tool integrations, or dedicated Vim prompt mode is claimed. Git-bundled Vim TUI is validated through ConPTY; Neovim, visual layout, and Korean IME composition remain manual blockers. See [Vertical Slice 1 validation](docs/validation/vertical-slice-1.md) for the exact 12-case evidence matrix and manual checklist.
