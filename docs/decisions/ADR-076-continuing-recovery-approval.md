# ADR-076: Continuing recovery approval

Date: 2026-09-13

Status: Signed source approval implemented in preparation, worker admission and
startup recovery. Full consecutive-update activation qualification remains pending.

## Contract

The initial installation retains its bootstrapper-pinned `approved-source.json`.
Later sources can be approved by the same pinned runtime using publisher-signed
release metadata, without replacing the launcher or modifying its initial approval.
The release manifest accepts this optional extension:

```json
{
  "recovery": {
    "schemaVersion": 1,
    "inventorySha256": "<SHA-256 of canonical recovery inventory>",
    "launchManifestSha256": "<SHA-256 of launch.json>"
  }
}
```

`recoveryInventoryBytes(files)` defines canonical encoding: file names sorted using
JavaScript's default string ordering, each entry serialized with `size` then
`sha256`, inside `{schemaVersion:1,files:{...}}`, UTF-8 without trailing newline.
It rejects escaping paths, case aliases, malformed hashes/sizes and excessive
counts/bytes. Release tooling must compute this from the final packaged payload
before signing the release manifest. A locally generated inventory hash alone
never grants approval.

Authenticated inactive preparation compares its extracted inventory with this
signed digest and exclusively persists `release.json`, `release.sig.json` and
canonical `inventory.json` under `update/recovery-sources/<version>` before reporting
completion. The proof holds no executable payload or extra archive copy. Partial
proof publication fails closed and is preserved; it is not silently overwritten.

This directory is durable recovery evidence, not disposable download cache. Keep
each proof for as long as its version can be active or used by an unresolved
rollback. Future cleanup must account for these references alongside version files.

## Recovery admission

Startup recovery and worker admission share source resolution. For later sources
they verify the stored publisher signature using the runtime's pinned trust policy,
channel, minimum bootstrapper version, exact source version and launch pin, and
canonical inventory digest. Initial-source pin mismatch never falls back to a
different approval mechanism.

Both flows now verify the exact installed source file set and all hashes, reject
redirections, missing/extra files, and require activity protocol 1. Startup recovery
repeats that check at its existing admission and Doctor authorization boundaries.
Doctor, activity exclusion, service compatibility checks, journal validation and
pointer rollback remain in place. Publisher authority proves file identity; it is
not evidence that a version was healthy, and does not authorize executing the
interrupted target or bypassing health validation.

The native bootstrapper requires a pinned trust policy when the inventory contains
the new recovery-source module. Old recovery-only inventories remain supported.
Existing deployed runtimes do not gain this capability merely by downloading a new
app; a runtime/launcher build containing this implementation is required. Older
manifest readers reject the added field safely. Release qualification must select
the appropriate minimum bootstrapper version when shipping this capability.

## Validation and limitations

- Ten source approval tests passed: two successive signed source identities with
  unchanged initial approval, signature/inventory/launch pin/payload/extra-file/
  missing-proof/untrusted-key refusals, legacy initial approval and canonical paths.
- Nine native preparation tests passed, including real extraction/publication and
  preservation of the signed inventory. Native tools were sandbox-blocked; the same
  isolated suite passed outside the sandbox with a simulated source observer.
- Thirty-two authentication tests and twelve worker/dispatch tests passed. Native
  launcher tests and vet passed; ESLint passed.
- The two-source test verifies approval and payload identity with fixture files;
  it does not execute two real application updates or claim reboot qualification.

No acceptance gates or manual VM tasks were added. Item 05 remains partial pending
actual activation handoff and its already-agreed integrated qualification. The
production signing key list remains empty. Release metadata generation must include
this extension before later-source recovery is available; legacy releases without
it retain initial-source-only approval. Service migrations and Repair composition
remain separate unfinished work.
