# ADR-023: Desktop packaging and executable smoke

## Status

Accepted for the Desktop MVP.

## Context

The Desktop control plane is useful for dogfood only if the packaged Windows executable exercises
the same runtime, preload boundary, renderer, and IPC contracts as development. A renderer-only
build can miss Electron ESM startup deadlocks and file-URL asset failures.

## Decision

The Electron main process is bundled with the existing HoneyBee runtime facade. Preload and
renderer remain separate bundles. The packaged application contains those outputs inside Electron
asar plus the `node-pty` JavaScript package; only its Windows x64 native runtime is unpacked. PDBs
and other-platform prebuilds are excluded. The renderer uses relative assets so the same build loads
from `file://`.

Main startup does not await `app.whenReady()` at ESM top level. Initialization runs from an
asynchronous ready callback after module evaluation, avoiding an Electron ESM readiness deadlock.

The Windows packaging command uses Electron Packager with a pinned workspace Electron version.
Generated staging and release directories are confined below `apps/desktop` and are not tracked.
The packaged smoke launches the generated executable with an isolated temporary `userData` root
and requires all of the following:

- Electron reaches `app.ready`.
- A sandboxed BrowserWindow is created.
- The preload exposes the strict versioned `window.honeybee` API.
- The renderer mounts the Command Center.
- Bootstrap crosses IPC and returns runtime API version 1.
- Preferences cross IPC with conservative defaults.
- Packaged `node-pty` loads and a real PowerShell ConPTY returns a known marker.

The smoke records only stage names in an OS temporary file, bounds captured diagnostics, kills only
the process tree it started, and removes its temporary profile.

## Consequences

`corepack pnpm --filter honeybee-desktop package:smoke` is the packaging release gate. It proves
the executable shell and IPC wiring, but it does not replace the environment-gated real Unity
transaction E2E or the operator dogfood checklist.
