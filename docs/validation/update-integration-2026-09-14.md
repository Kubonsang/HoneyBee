# Update integration checks — 2026-09-14

## Current status (supersedes the historical snapshots below)

Implemented and connected in source:

- Authenticated inactive application preparation, Desktop shutdown/activity drain,
  one service-only UAC session, native protected service replacement, isolated
  Desktop readiness/Doctor, paired commit or source restoration.
- Protected automatic SCM recovery worker and user Launcher combined recovery,
  including a durable native abort decision before an uncertain commit can roll back.
- Newer Setup uses embedded signed update media and the installed pinned worker.
  It handles idle Desktop, normal shutdown/cancellation, and retains the original
  Launcher, shim and recovery runtime. Older bootstrappers without this entry point
  are refused before update mutation.
- Matching Setup retry and application Repair after an update validate the original
  infrastructure receipt/runtime pin and the approved selected application. Damaged
  app bytes remain preserved. A byte-identical stopped automatic service can be
  started through the shared service primitive; foreign/damaged service binaries or
  disabled startup policies are not overwritten by this repair.
- Recovered combined updates display their bound terminal journal even when the
  original worker's completion result was interrupted or failed.

Validation performed locally: native Storage tests passed (temporary-file/handle
fixtures, not live SCM), Launcher tests and vet passed, core/Desktop main builds
passed, update/installation ESLint passed. The combined/activation/publication/
Repair/Setup regression selection passed 68 tests. Separate Setup transport,
worker, embedded signature/hash and recovery outcome checks passed. Counts from
overlapping runs must not be added as independent qualification gates.

The newly built managed host has a distinct component identity,
`0.0.0+cfa606fd4143.hb13`; the old published hb12 host does not implement the
maintenance-pause protocol and is not admitted as an automatic migration source.
The pinned upstream client and overlay remain unchanged. Production Ed25519 trust
is configured; Windows Authenticode remains explicitly deferred by the user.

Still required before publication: the supported real service migration pair
with populated Workspace preservation, the fixed final
VM/WinGet acceptance run and candidate-bound distribution review/publication.
Bootstrapper reconstruction and damaged service-binary replacement are not covered
by the startup/application Repair implementation. No final acceptance gate or public
beta release has been claimed from these local checks. No additional manual QA
bundle has been requested.

### Built candidate

The integrated `0.1.0-beta.12` candidate was assembled with its pinned recovery
runtime. Its manifest was signed using the existing DPAPI-protected production
Ed25519 key. The key was not exported. Distribution output is
`output/distributions/distribution-mKs3Fp/`:

- `HoneyBeeSetup.exe`: 417,092,167 bytes,
  SHA-256 `30f23bf7a5e60e63f6944ed143264df36c493d998592bcba3b40ed713e38fefa`.
- `application.zip`: 219,160,896 bytes,
  SHA-256 `bc8900db74ff65736e4e6290ddf9a997e5b62164bedc6a369de8e457c79eb031`.
- Manifest SHA-256:
  `d854be16d07f0d4a94611eac57a0855f85f908373954be570a427c209dbe136f`.

The actual Setup passed isolated silent application installation checks: missing
Git refused before publication, complete inventory matched, the CLI shim ran,
existing registry bytes were preserved, and unrequested repeated installation
refused. It did not install/replace the host service; `ready: false` was expected
with that host's incompatible existing service. This is not a fresh-service gate pass.
Artifacts, manifest signature and generated WinGet bytes passed offline distribution
review. Local WinGet installation and final VM acceptance remain unrun.

The existing acceptance evidence was attached as partial evidence instead of being
discarded. None was promoted into a final pass for these new candidate hashes.
`output/current-distribution-final-local-review.json` records this distinction and
keeps publication disabled. The real service replacement pair has not yet been
packaged/qualified; the current manifest offers only app-only updates from a
compatible managed service, not migration of the old published hb12 service.

Packaging also exposed two build issues: the isolated builder omitted update
modules imported by Desktop, and a retained `app.asar` handle denied the final
directory rename (native sharing error 32). The builder now copies its dependencies.
Assembly retries the final rename and can create a new verified build output while
preserving locked staging. This fallback is restricted to owned build paths, never
the user's active installation. Regression checks cover retry, destination races,
and preserved source/copy inventory.

## Historical snapshots

Scope: recent ADR-082/083 changes under the existing 16 acceptance gates.
These are local automated checks, not final candidate or VM qualification.

| Check                                                                                                                                   | Result                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Fresh installation, service setup, Repair admission                                                                                     | 28 Node tests passed                 |
| Desktop sessions (including isolated validation), core combined admission, candidate-bound acceptance, release authentication/discovery | 41 Node tests passed                 |
| Desktop update lifecycle: cancellation, shared activity, rollback, restart refusal/failure, readiness                                   | 11 Node tests passed                 |
| Native Ed25519 release authentication                                                                                                   | Passed, including rejection subtests |
| Native migration rejects app selection without protected paired commit authorization                                                    | Passed                               |
| Existing Launcher suite                                                                                                                 | Passed                               |
| Added Launcher combined journal admission regression                                                                                    | Passed                               |
| Core/Desktop TypeScript build; added JavaScript test lint                                                                               | Passed                               |

Total successful Node checks: 80. Go results are listed separately; they are not
included in that count. Tests use fixtures and do not replace the installed service.

## Initial failures resolved

The first Desktop session attempt could not import its generated main-process
module. Building core and Desktop main produced the required files; the session
suite then passed. This was missing test preparation, not an application failure.

The lifecycle suite initially failed when the Windows activity helper received
Access denied inside the sandbox. The same focused suite ran successfully with
the sandbox restriction lifted. This did not request service installation or UAC.

## Regression coverage added

- Validation readiness is bound to the transaction and cannot satisfy normal
  restart readiness; denied authorization cannot launch; existing sessions reuse.
- Core and native Launcher refuse ordinary clients while a combined transaction
  is pending, allow only the matching validation session in permitted states,
  refuse a CLI validation bypass and reject corrupted history.
- Acceptance results cannot be transplanted between candidates or promoted from
  historical fixture scope into a final pass.
- Repair admission test is now included in `test:setup`.
- `test:update-admission` builds its dependencies before running the session and
  combined admission regression checks.

## Not qualified by this run

The combined coordinator and production native service adapters are not end-to-end
qualified. Real Electron validation profile behavior, signed distribution review,
damaged-app reconstruction, Setup/VM integration and the supported real migration
pair remain pending. The current production trust store has no configured release
keys. No final signed candidate exists in this check, so none of the 16 final gates
is automatically marked passed. Existing historical QA remains preserved.

There is no new manual VM bundle to run. Complete missing integration and production
inputs before scheduling the already agreed single final candidate qualification.

## Follow-up: paired rollback and native SCM binding

Code inspection found a real adapter contract mismatch: the JavaScript combined
coordinator restored the service before restoring the source app pointer, while
native migration rollback requires source app selection. The coordinator now
restores the app selection first, with ordinary launches blocked by RollingBack,
then restores the service, validates the pair and permits restart.

Three added combined coordinator tests passed: source-before-service restoration,
interrupted restoration with replay, and uncertain protected commit with forward
retry and restart failure. They use the real installation lock and fixture adapters,
not real SCM changes. The lock helper required the same sandbox exception as the
lifecycle checks. Successful Node checks recorded here now total 83.

`maintenance_binding_windows.go` connects the native SCM handle to the existing
stop/resume implementation and source-file guard. It opens only the fixed service,
requests no service create/delete rights, binds initiating SID/store/configuration
to admitted evidence and rejects operations after close or loss of protected
maintenance ownership. The bound source handles are released between operations
so cold backup can obtain exclusive ownership. Opening does not change SCM state.

Two binding tests (including identity rejection subtests) passed without opening
the real service. The related native migration, maintenance service and process
handle test selection also passed. New JavaScript files passed ESLint.

This connection is not yet a public migration command. Its recovery callback must
actually persist the protected boot recovery entry before disabling startup. The
factory describes a live admitted source; reopening a stopped/disabled service
after reboot needs a separate protected-original-config recovery admission. The
upstream broker's periodic recovery and in-flight pipe requests still require a
maintenance boundary before reserving topology. None of these requirements is
waived by the fixture passes.
