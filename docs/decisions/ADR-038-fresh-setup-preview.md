# ADR-038: Fresh application setup preview

## Status

Accepted for development qualification only. ADR-040 supersedes the original
service-free behavior below for interactive setup; silent setup remains read-only
with respect to services. End-to-end fresh service installation
remains incomplete. Do not promote this artifact as the ordinary HoneyBeeSetup.exe.

## Boundary

NSIS extracts an offline payload and runs its private Node runtime with the setup
helper. It requests the original user's normal execution level and defaults to
`%LOCALAPPDATA%\HoneyBee`. Existing Electron/Core state locations remain unchanged.
See the [NSIS execution reference](https://nsis.sourceforge.io/Docs/Chapter4.html)
for `RequestExecutionLevel` and `ExecWait` behavior.

The helper verifies a build-time SHA-256 inventory of every application file,
including dependencies, before changing the target. These hashes check consistency;
they do not authenticate a publisher. Signing and toolchain qualification remain
release gates.

`versions`, `bin`, `HoneyBeeLauncher.exe`, and `current.json` are exclusive owned
entries. Any existing entry blocks installation, including incomplete prior work.
Other entries, particularly `workspace-core`, remain untouched. Setup does not
adopt projects, change PATH, register an uninstaller, create shortcuts, delete
files, or upgrade an existing installation. These preview limitations do not define
the final installer UX.

## Publication and failure behavior

1. Verify the source inventory and reject a redirected target root.
2. Create `.setup-pending` exclusively as a concurrent-install lock and recovery
   evidence. A previous attempt blocks retry.
3. Sync `prepared.json`; exclusively reserve the inactive `versions` and `bin`
   directories. Copy each payload file exclusively, sync it, and verify its hash.
   Copy and verify the Launcher and stage the pointer under `.setup-pending`.
4. Sync `verified.json`, then rename only the staged pointer to `current.json`.
   Launcher cannot select the partial release before this point. Avoid renaming
   populated directory trees: Windows directory watchers can hold them open.
5. Sync `published.json`; run installed-storage discovery and the existing
   `requireCompatibleStorage` checks for receipt, identity, hashes, version and
   manual-recovery status. Record `health.json` separately from app publication.

Exit 0 means application publication and storage health passed; interactive setup
starts the stable Launcher. Exit 2 means app files are installed but storage needs
attention; setup reports this and does not auto-launch. Exit 1 means setup failed.
A complete published app may remain available for diagnostics after a late failure.
No failure triggers service or user-data deletion.

A process crash before activation leaves evidence without an active partial
release. A crash after activation leaves complete app files. File sync and pointer
publication are not power-loss qualification. Automatic resume, recovery UI and rollback
remain pending. Do not delete `.setup-pending` or partially published entries to
force retry on a real installation. This preview is for disposable environments.

## Elevation prerequisite

ADR-039 implements the admission-before-mutation prerequisite in host source. The
packaged preview host and UAC integration remain pending; the original finding below
explains why automatic elevation was withheld.

Storage Host `install` previously secured directories and applies ACLs before
checking existing SCM service and receipt identity. Automatically invoking it for
an unknown service could change machine state before admission fails. Before
connecting elevation, move admission before mutation, distinguish missing services
from SCM access failures, preserve the initiating SID across alternate-admin
credentials, and test interruption/retry at each fresh-install step. Service
replacement needs a separate transaction; setup must never silently add `--replace`.

## Build and validation

Set `HONEYBEE_MAKENSIS` to a reviewed NSIS compiler, or provide `makensis` on PATH:

```powershell
node scripts/installation/build-setup.mjs <absolute-assembled-root>
node scripts/installation/smoke-setup.mjs <absolute-setup-exe>
node --test scripts/installation/fresh-install.test.mjs
```

Each build creates `output/setup/build-*/HoneyBeeSetup-preview.exe`. The smoke
installs silently under a unique repository output folder, preserves a sentinel
registry, runs the stable CLI, checks health/exit-code agreement, and proves that
reinstall cannot overwrite the installed tree. Service readiness is observed
read-only. No actual user registry/profile or service installation is changed.

Unit tests inject interruption before every publication step, corrupted and extra
payload files, directory redirection, and competing installers. They do not prove
UAC/service installation or hard-reboot recovery. Clean-VM UI, disk-full, signing,
compiler qualification and service installation tests remain distribution gates.
Local preview compilation used the Electron builder NSIS 3.0.4.1 tool distribution;
this is build evidence only, not approval of that compiler for production releases.
