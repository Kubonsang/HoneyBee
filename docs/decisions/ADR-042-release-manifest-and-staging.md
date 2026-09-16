# ADR-042: Release manifest and isolated update staging

## Status and boundary

Implemented as a developer-only Node primitive under `scripts/update`, following
ADR-041. It stages opaque package bytes and checks integrity. It does not yet
provide Desktop update discovery, authenticated release selection, archive
extraction, installation, service replacement, activation, or rollback.

The stable launcher remains a local launch/verification component. Network policy
belongs in the updater, running without elevation. The existing private Node
runtime can eventually run it independently of Desktop; this increment is not
included in installed packages or connected to the launcher.

## Manifest v1

One application ZIP is referenced by all three components. The assembly already
contains Desktop, CLI, private Node, and paired Storage client/control tools;
separate downloads would duplicate that inventory and risk mixing releases.
`release.json` is distinct from local `launch.json` and `installation.json`.

Illustrative metadata only: the URL, size and digest below are placeholders, not
an available release. The actual ZIP must be the app-only version payload defined in ADR-043, built
from a qualified managed assembly. Full installation and older Desktop-only ZIPs
are not update packages.

```json
{
  "schemaVersion": 1,
  "version": "0.1.0-beta.12",
  "channel": "beta",
  "mandatory": false,
  "minimumSourceVersion": "0.1.0-beta.11",
  "minimumBootstrapperVersion": "1.0.0",
  "packages": {
    "application": {
      "url": "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.12/HoneyBee-update-win32-x64.zip",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 123456789,
      "format": "zip"
    }
  },
  "components": {
    "desktop": { "version": "0.1.0-beta.12", "package": "application" },
    "cli": { "version": "0.1.0-beta.12", "package": "application" },
    "storage": {
      "componentVersion": "0.0.0+cfa606fd4143.hb12",
      "package": "application",
      "migration": {
        "kind": "none",
        "supportedSourceVersions": ["0.0.0+cfa606fd4143.hb12"]
      }
    }
  }
}
```

The parser requires all fields, rejects unknown fields/schema versions, and bounds
metadata to 64 KiB and the package to 4 GiB. Release versions support the repository's
`major.minor.patch[-beta.N]` grammar with numeric prerelease ordering; other version
schemes require an intentional contract revision. Stable channels cannot publish
beta targets. Desktop and CLI versions must equal the release version.

Admission checks the caller's source version against the minimum source and newer
target, the bootstrapper minimum, selected channel, and exact supported Storage
source identifier. Storage identifiers remain opaque: no ordering or migration
inference from `hb11`/`hb12`. `none` requires the same source/target compatibility.
`service-replacement` describes a requirement only; it grants no permission to
replace a service or run code supplied by a manifest. `mandatory` is advisory
metadata and cannot bypass admission or future recovery gates.

The bootstrapper minimum is a future distribution contract, not a claim that the
current launcher has version 1.0.0. The developer entry point accepts local source
facts as arguments. Production integration must obtain and verify those facts
from the managed installation and live service, then recheck them before any
mutation. Signed discovery, channel/replay policy, and an authenticated metadata
format must be designed before enabling automatic installation. Unknown signature
fields are rejected now rather than silently treated as authenticated.

## Staging and trust

`stageRelease` accepts exact manifest bytes and a required SHA-256 supplied by the
caller. A digest pins metadata; it does not establish publisher identity. Do not
obtain both unchecked metadata and its purported trusted digest from an untrusted
source and call the result authenticated. `Verified` means only that downloaded
bytes match this pinned manifest. The result explicitly sets
`activationAllowed: false`. An arbitrary byte stream matching its digest can be
staged; ZIP structure and extracted inventory validation belong to preparation.

Only HTTPS GitHub release asset URLs within `Kubonsang/HoneyBee` are admitted.
Redirects are handled manually, checked before each request, and limited to five;
GitHub's `release-assets.githubusercontent.com` destination is allowed. Credentials,
nonstandard ports, fragments, other repositories/hosts and HTTP are rejected.
No authentication headers are supplied. The downloader requests identity encoding,
requires status 200, rejects encoded responses and inconsistent Content-Length,
bounds streamed bytes to the manifest size, and checks final size and SHA-256.
The entire transfer uses a 15-minute cancellation deadline; callers may cancel
sooner. Tests inject transport, never contact a release server.

The existing installation root and its ancestors must be plain directories.
A pre-existing redirected `update` path is refused. Each attempt gets a unique
`update/stage-*` directory; filenames are fixed locally, never supplied by metadata.
All creations are exclusive. These checks avoid accidental redirects; this is not
a security boundary against another process running as the same user and racing
filesystem changes. No part of this updater should run elevated.

## Journal and interruption

```text
update/stage-<unique>/
  release.json
  001-Downloading.json
  application.zip.partial
  002-Downloaded.json
  application.zip
  003-Verified.json
```

The package starts as `.partial`. Manifest and sequential journal records are
written exclusively and file-synced; package bytes are file-synced and closed
before `Downloaded`. Exact size/hash verification precedes renaming the package
and writing `Verified`. Caught failures append the next numbered `Failed` record
when storage remains writable. Signed redirect query strings and transport error
text are not copied into failure records.

An abrupt process exit can leave a missing/truncated record or a renamed package
without `Verified`. Disk-full can also prevent the failure record. No record,
including `Verified`, is authority to launch or mutate anything. A future consumer
must re-read and authenticate metadata, re-hash staged files and repeat admission;
never trust a filename or journal marker alone. File sync improves persistence,
but sudden power loss and Windows directory-entry persistence still require VM
qualification before activation relies on a durable transaction.

Retry creates a new attempt and preserves the old evidence. Range resume, journal
replay, automatic cleanup/quota management and reboot orchestration are deferred.
The installed `current.json`, versions, projects, workspaces, registry and service
are not modified, so even a hard process termination leaves the active app intact.
This is isolation of download failure, not service migration rollback.

## Developer use and verification

```powershell
node scripts/update/stage.mjs INSTALL_ROOT MANIFEST_PATH MANIFEST_SHA256 CURRENT_VERSION BOOTSTRAPPER_VERSION CHANNEL STORAGE_COMPONENT_VERSION
node --test scripts/update/stage-release.test.mjs
```

The destination must already exist. Prefer an isolated directory under `output`
for development. `stage:update` exposes the same command through package scripts;
`test:update` is included in `test:run`, hence the Windows `pnpm verify` job.
No production feed or release publication is created by these commands.

Tests cover strict metadata and version admission, repository/redirect policy,
bounded transfers, digest mismatch, truncated and excess bytes, HTTP/encoding
failure, network interruption, cancellation, simultaneous attempts, directory
junction rejection, and killing a real downloader child process mid-transfer.
Failure tests check preservation of pointer/registry fixtures and successful retry
in a separate attempt. Tests preserve their small evidence directories under
`output/update-tests`. Real GitHub download, disk-full, machine reboot/power loss,
and signed production release qualification remain outstanding.

ADR-043 now defines and validates the app-only extracted inventory in an inactive
version directory, with traversal/reparse protection and bounded extraction. Keep
activation gated until durable commit/rollback and service compatibility recovery
exist. Never copy a bundled root launcher, shim, or current pointer over the active
installation as an ordinary application update.
