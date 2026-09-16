# ADR-037: Installation assembly and explicit storage adoption

## Status

Accepted. Extends ADR-035 and ADR-036 without adding a service updater.

## Installation assembly

`pnpm prepare:installation-runtime` downloads the official Node.js 24.13.1 Windows
x64 ZIP, checks a source-pinned SHA-256 from the official SHASUMS256.txt, and
prepares `node.exe`, `LICENSE` and a provenance record. The runtime version is a
deliberate build input; it does not follow the developer's Node executable or PATH.

After building the existing Desktop/CLI packages and Launcher, run
`pnpm package:installation`. It assembles a new tree under
`output/installations/<version>-<unique-id>/HoneyBee`:

```text
HoneyBeeLauncher.exe
bin/honeybee.exe
current.json
versions/<version>/
  launch.json
  installation.json
  desktop/                 complete Electron package
  cli/                     complete CLI package
  runtime/                 pinned Node executable, license and provenance
  tools/                   approved storage tools and their manifest
```

Assembly verifies matching package/storage identities, copies into an unpublished
staging directory and renames the completed tree into place. Every build gets a
new directory. It does not overwrite a working installation, write to LocalAppData,
modify PATH, or install/replace a service. An interrupted build leaves staging
evidence and cannot activate a partially assembled installation.

This is a preview assembly, not a transactional installer or an update commit.
It contains duplicate storage payloads from the original packages; deduplication
is deferred. User state stays in the existing Workspace Core registry and existing
Electron profile. No profile or service data is relocated.

`launch.json` now optionally includes `installationSha256`. The new Launcher
checks this digest before execution when present. Older launch inventories without
this field remain supported; old Launcher binaries reject the new field, so this
assembly always includes the matching new Launcher. `installation.json` records
schema 1, the app version, exact storage component version and client/control
hashes. These local inventories are consistency checks, not signed publisher trust.

Desktop and CLI discover this metadata from their own immutable version directory,
not `current.json`. The Go launcher resolves activation once; an already running
process continues to use its own tools after another version becomes active.
Missing/corrupt metadata in a managed layout fails without portable fallback.

## Project binding

The existing schema-2 project record gains an optional field:

```json
{
  "storageBinding": {
    "kind": "managed-v1",
    "installationRoot": "C:\\Users\\Example\\AppData\\Local\\HoneyBee"
  }
}
```

The original `storageCommand` remains unchanged during adoption. A bound project
selects the active process's verified tools only when the installation root
matches. Unbound projects retain their original executable paths. A different
installation or a portable process fails rather than overriding a managed binding.
An explicit custom path on a newly registered project remains unbound. New projects
registered with the installed default tools receive a binding automatically.

Managed Workspace operations additionally require a matching running service,
valid matching receipt/binary digest, accessible service Workspace root and user
identity. This step does not migrate that service; mismatches remain blocked.

## Existing project adoption

The internal Core primitives are `planProjectStorageAdoption` and
`adoptProjectStorage`. The beta diagnostic CLI exposes them as:

```powershell
.\bin\honeybee.exe project adopt-tools <project-id> --json
.\bin\honeybee.exe project adopt-tools <project-id> --apply --json
```

Without `--apply`, this is a read-only preview. No bulk adoption occurs at launch.
Only exact source client/control bytes matching the current approved component can
be adopted in this step. Custom, missing or older incompatible payloads are blocked;
filenames and folder names are never sufficient proof. This deliberately excludes
service migration and unknown ZIP provenance. Even matching custom bytes are
adopted only when the user explicitly selects that project for application.

Apply repeats payload/service validation and compares the project digest. Under
the existing registry writer lock it rechecks that digest, creates an exclusive,
synchronized byte-for-byte registry backup, and uses the existing synchronized
temporary-file/rename publication primitive. Only the chosen project's binding
changes; other projects, authored files, Workspace records, parent identities,
branches and removal receipts remain unchanged.

A crash before publication leaves the old registry plus a backup. A crash after
publication leaves the new binding plus its backup. Retry replans: an already bound
project is a no-op, while concurrent edits reject a stale plan. Backups are retained
at `workspace-registry-before-adoption-<uuid>.json` and are never automatically
restored over newer user changes. Restoring one manually requires exclusive access
and a comparison with the current registry; this is not general rollback machinery.

The new parser still reads schemas 1 and 2. Older HoneyBee builds do not understand
the optional binding and may drop it on a registry write. The preserved original
path supports legacy recovery, but mixed old/new writers are not a supported
managed update workflow. Installation admission and legacy-client fencing remain
future work. A managed installation root must stay stable after adoption.

## Qualification

Core tests cover exact backups, no-op retry, custom/missing bytes, service/SID
mismatch, stale plans and unrelated-project preservation. Installation discovery
tests verify pinned release resolution and fail-closed corruption behavior.
`pnpm smoke:installation <absolute-root>` launches the real stable CLI with the
private runtime, checks a bound fixture whose old ZIP path is missing, and runs the
real Desktop IPC/UI fixture from the assembled layout. The fixture uses its own
registry/profile and never applies adoption to real user projects or changes SCM.
Existing native Launcher A/B tests remain in the qualification chain.

The Windows workflow publishes the tested tree as an installation-preview artifact.
Service readiness is not implied by a successful assembly smoke: Doctor may report
that a machine service is absent or incompatible. Fresh install/service health,
signing, transactional updates and automatic recovery remain separate phases.
