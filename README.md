# Honey Bee

Honey Bee is a CLI-first orchestrator. Its current proof starts a producer Agent and a reviewer Agent as two real OS processes, captures the producer's result, hands that result to the reviewer through HoneyBee Core, and returns the reviewer's final result.

## Requirements

- Windows 11
- Node.js 24 or newer with Corepack
- Codex and OpenCode only for the optional real-Agent example
- Git for Windows only for the retained PTY/Vim regression tests

## Install and build

From a PowerShell prompt in the repository root:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm security:install-hooks
corepack pnpm build
```

The primary artifacts are `apps/cli` and `packages/core`. The build also compiles retained lower-level packages while the CLI migration continues.

## Prove the two-process handoff

Run the deterministic smoke proof. It launches two separate Node Agent processes, prints both PIDs and the `producer -> reviewer` handoff, and returns the reviewer result.

```powershell
corepack pnpm build
corepack pnpm honeybee demo --task "count bees" --json
```

Run installed Agent CLIs with a config file:

```powershell
corepack pnpm honeybee run --config examples/codex-opencode.windows.json --task "Summarize this repository and check the summary"
```

The config contract is `schemaVersion: 1` plus `producer` and `reviewer` objects. Each Agent has a `command`, optional `args`, `cwd`, and `env`. HoneyBee sends each Prompt through stdin and treats stdout as that Agent's result. Relative working directories resolve from the config file, and `${VARIABLE}` references in `command` and `cwd` resolve from the environment. `examples/codex-opencode.windows.json` invokes OpenCode's native executable instead of its PowerShell/CMD shim so HoneyBee can retain `shell: false`. It assumes Codex and OpenCode are already installed and authenticated; the deterministic `demo` requires neither network nor an AI account.

The implementation boundary is:

```text
apps/cli -> packages/core -> child process A
                         -> handoff
                         -> child process B -> final result
```

## Quality and tests

```powershell
corepack pnpm verify
```

`verify` runs the public-source secret scan, production license allowlist, formatting, ESLint, strict package typechecks, TypeScript builds, Vitest, and dependency-cruiser architecture rules.

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

Honey Bee is available under the [MIT License](LICENSE). Production dependency licenses are allowlisted and checked from the lockfile-installed graph; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The current scope is deliberately limited to one producer-to-reviewer handoff. PTY/TUI orchestration, persistence, retries, parallel fan-out, and graph workflows remain future work. See [ADR-013](docs/decisions/ADR-013-core-cli-first-handoff-proof.md).
