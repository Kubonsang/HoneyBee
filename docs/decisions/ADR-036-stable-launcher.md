# ADR-036: Stable native entry points

## Status

Accepted as the next installation/update foundation after ADR-035.

## Decision

Build two Windows x64 executables from `tools/honeybee-launcher`:

- `HoneyBeeLauncher.exe`: Windows GUI entry point for Desktop.
- `bin/honeybee.exe`: console entry point for CLI.

They locate the installation relative to their own executable paths, read one
`current.json`, and select immutable payload paths under `versions/<version>`.
They never use PATH to discover an application runtime, search for a newer version,
or rewrite installation state. CLI invokes the selected private Node runtime
directly, preserving arguments, working directory, streams and exit status.
Desktop starts the selected executable and releases the child process.

The launcher module uses the Go standard library only. Windows error UI is a
small native message box, so a damaged Electron payload does not prevent an error
from being shown. The CLI emits errors to stderr and returns exit code 1.

## Local filesystem contract

```text
HoneyBee/
  HoneyBeeLauncher.exe
  bin/honeybee.exe
  current.json
  versions/0.1.0-beta.12/
    launch.json
    desktop/HoneyBee.exe          complete Electron package beside this file
    runtime/node.exe              approved private Node runtime
    cli/dist/cli.js               complete CLI package under cli/
```

`current.json` is UTF-8 JSON without BOM:

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "activeVersion": "0.1.0-beta.12",
  "manifestSha256": "<sha256 of exact launch.json bytes>"
}
```

`launch.json` is a bounded local launch inventory, not the future signed network
release manifest:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0-beta.12",
  "desktopSha256": "<sha256 of desktop/HoneyBee.exe>",
  "nodeSha256": "<sha256 of runtime/node.exe>",
  "cliSha256": "<sha256 of cli/dist/cli.js>"
}
```

Both schemas reject unknown fields, unsupported schema versions, trailing JSON
and files larger than 64 KiB. Version names cannot contain path separators, drive
names or traversal. Each path component beneath the installation root must be a
real directory or regular file; Windows reparse points are rejected. Metadata
identity and the selected launch payload hashes must match before execution.

The selected paths remain fixed even if activation changes after resolution.
Future activation writers must publish a fully staged version first, atomically
replace the pointer, and retain versions referenced by running processes. A/B
switching is tested here, but no production activation writer is included yet.

## Safety and limits

The launcher runs with ordinary user privileges. Local hashes detect inconsistent
payloads; they do not authenticate a publisher, verify an entire Electron/Node
dependency tree, or prevent same-user replacement between verification and launch.
Signed manifests, complete package inventories and maintenance locking belong to
the upcoming installer/updater transaction.

There is no service migration, health-based commit, automatic rollback, reboot
recovery, launcher self-update, PATH modification or uninstall registration yet.
A broken active version fails rather than guessing a previous compatible version.
Desktop child startup success is not a health check.

Portable Desktop and CLI packaging remain unchanged. Existing registry and service
roots are not moved. The launcher does not enable a managed storage selection:
automatic adoption of registered tool paths must first distinguish legacy/custom
bindings. Consequently this step alone does not remove the existing project's
tool-path re-registration requirement. ADR-035 provides the resolver for that
subsequent adoption work.

## Build and qualification

`pnpm build:launcher` writes build artifacts only under `output/launcher`.
`pnpm test:launcher` runs Go tests and vet. `pnpm smoke:launcher` exercises the
compiled GUI and console entry points using disposable test payloads and the
current Node executable. This Node copy is only a test fixture, not a licensed,
version-qualified distribution runtime.

Qualification covers two active versions, unchanged launcher/shim hashes, Unicode
and quoted arguments, stdin/stdout/stderr, exit-code propagation, inherited cwd,
invalid/missing metadata, altered payloads and an intermediate Windows junction.
The Windows quality workflow builds and smoke-tests both native artifacts.

The next step is assembly of a complete managed installation plus explicit,
transactional storage-binding adoption. Installer and service automation remain
separate changes.
