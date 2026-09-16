# ADR-043: Prepare an isolated application version from an update ZIP

## Status

Implemented after ADR-042 as a developer-only preparation primitive. The stage
consumer now rechecks metadata, source admission and ZIP integrity, extracts an
inactive version, and validates its files. It does not activate the version,
execute payloads, request elevation, stop Desktop, or change the service.

## Package contract

An update ZIP contains the contents of one assembled `versions/<version>` directory:

```text
launch.json
installation.json
desktop/...
cli/...
tools/...
runtime/...
```

The root Launcher, `bin` shim, `current.json`, README and user state are excluded.
The existing full installation preview ZIP and old Desktop-only ZIP are not update
packages. All three release-manifest components still reference one application
package. Its exact bytes remain bound by the release manifest SHA-256.

`tools/honeybee-update-package` is a separate Go command, not a launcher extension.
It uses the standard library [archive/zip](https://pkg.go.dev/archive/zip) reader and
writer. `pack` walks a trusted assembled version, refuses redirected/non-regular
sources and unsupported paths, and exclusively creates a ZIP. `extract` opens and
hashes the archive before any destination creation, then inspects every entry.
Extraction reads ZIP streams to completion, including CRC verification, and hashes
and syncs each output file. No generic shell extraction command is used.

The v1 limits are 4 GiB compressed, 8 GiB expanded, 2 GiB per file, 20,000 entries,
20 path segments, and 220 bytes per relative filename. The archive central directory
is parsed by Go before the entry-count check; these limits are not a constant-memory
sandbox for hostile multi-gigabyte metadata. Production publisher authentication
and resource qualification remain required.

Paths must use forward slashes and printable ASCII within the archive. The outer
installation directory may contain Unicode; the native smoke uses a Korean name.
Absolute paths, traversal, empty segments, backslashes, alternate streams, Windows
device names, trailing spaces/dots and unexpected top-level entries are refused.
Entries must be regular files with Store/Deflate compression; explicit directory
entries, links, reparse attributes, encryption, duplicate or case-aliased paths,
and file/directory collisions are refused. The builder omits empty directories.
These restrictions are deliberate for HoneyBee-produced packages, not general ZIP
compatibility. Changes to packaging must keep this contract or revise it explicitly.

Extraction requires a new destination. Existing directories are never reused or
overwritten. Ancestors are checked for redirection; every output is created
exclusively. The tool runs as the user and is not a privilege boundary against
another process under the same account racing path changes.

## Preparation boundary

`prepareRelease` accepts the installation root, a direct `update/stage-*` child,
the expected manifest digest, and source facts. It ignores `Verified` marker claims:
manifest bytes, admission, archive size and archive SHA-256 are checked again.
The current pointer must have schema 1 and match the supplied source version;
its bytes must remain unchanged through validation.

Preparation creates a separate attempt:

```text
update/prepare-<unique>/
  001-Preparing.json
  versions/<target-version>/...
  inventory.json
  002-Prepared.json
```

Keeping the inactive tree here avoids reserving the live `versions/<version>` name
before a commit protocol exists and permits repeated beta builds and retries.
Publication into the live version directory is a later transaction operation.
No ordinary update may overwrite an existing version with the same identifier.

The extractor returns the size and SHA-256 of every file. Preparation persists
that inventory and then independently re-enumerates and re-hashes the complete
tree, rejecting missing, added, redirected or changed files. It checks:

- `launch.json` and `installation.json` schema/version identities and hash binding;
- Desktop executable, private Node and CLI entry digests, plus Desktop app.asar presence;
- the exact Storage component version and paired tool digests in all three bundled locations;
- CLI package version, Desktop compatibility metadata and client/control approvals;
- each bundled tool manifest's version, file digest and size declarations;
- private runtime executable and license against packaged provenance digests.

These are structural and integrity checks, not application health validation.
Doctor, service compatibility admission and runtime smoke must precede activation.
Packaged runtime provenance is checked for internal consistency; publisher trust
must come from authenticated release metadata, not from the package claiming its
own approval. No source version or bootstrapper identity is automatically discovered
by this developer CLI yet. The existing SHA pin is not a signature.

## Failure and recovery

Failure retains the inactive tree and inventory when available and attempts an
exclusive, file-synced `002-Failed.json`. Disk-full may prevent that final record.
Process termination can leave only `Preparing`, a partial tree, or a truncated
record. None of these files authorizes launch or service mutation. Retry creates
another attempt; no cleanup or overwrite is performed automatically.

`Prepared` also remains non-authoritative and returns `activationAllowed: false`.
A future commit consumer must authenticate metadata, verify inventory again, and
repeat current-pointer/live-service admission. App/service transaction journaling,
backup, rollback, reboot recovery and durable publication are not implemented by
this step. File sync does not replace power-loss/Windows filesystem qualification.

## Commands and qualification

```powershell
node scripts/update/build-package-tool.mjs
& ./output/update-tools/honeybee-update-package.exe pack ASSEMBLED_VERSION_DIRECTORY NEW_ZIP_PATH
node scripts/update/prepare.mjs INSTALL_ROOT STAGE_ATTEMPT MANIFEST_SHA256 CURRENT_VERSION BOOTSTRAPPER_VERSION CHANNEL STORAGE_VERSION
node scripts/update/smoke-prepare.mjs ASSEMBLED_VERSION_DIRECTORY
```

`build:update-package`, `prepare:update` and `smoke:update` expose these Node commands.
`test:update` now runs the Go tests/vet, builds the helper, and runs staging plus
preparation tests. Windows CI runs a complete real-assembly pack/stage/prepare smoke
and preserves its console evidence with the existing quality artifacts. It does
not publish an update release or include this developer helper in installed Setup.

Local validation on 2026-09-10:

- Go tests/vet passed: unsafe paths, duplicate/case paths, file/directory collisions,
  links, oversized entries, wrong package digest, corrupt CRC, roundtrip and overwrite refusal.
- All 29 Node staging/preparation tests passed, including source/metadata failures,
  tool mismatch, missing runtime, modified staged ZIP, modified extracted bytes and
  injected failures before extraction, after extraction and before Prepared.
- A real beta.11 managed assembly produced a 213,186,181-byte application ZIP and
  passed preparation under a Unicode output path. The final helper and metadata
  checks were also run against this staged ZIP. Pointer and user-state fixture
  contents remained unchanged. The smoke's source version is a synthetic 0.0.0;
  this is not evidence of an actual installed-version migration or app launch.

Go directory checks required execution outside the tool sandbox after sandbox
Access denied errors; tests still used only disposable temp/output fixtures and
performed no Windows service or user-installation changes. Sudden machine reboot,
power loss, disk-full and kill-during-native-extraction qualification remain open.
The prior downloader kill test continues to run, but is not claimed as an extractor
kill test. Next work must connect service preflight and recoverable publication
before enabling a user-facing Update & Restart action.
