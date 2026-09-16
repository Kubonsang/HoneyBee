# ADR-085: Explicit unsigned beta distribution and protected release key

Date: 2026-09-14. Status: distribution/key implementation; final candidate not qualified or published.

The user approved deferring Windows Authenticode signing, completing the remaining
installation/update work, and publishing a GitHub beta prerelease. The fixed
acceptance scope is unchanged apart from that explicit signing exception. There
will be one final integrated VM bundle and no new per-feature manual bundles.

## Distribution policy

`prepare-distribution.mjs` and `review-distribution.mjs` accept `releaseMode`:
`signed` (default) or `unsigned-beta`. Signed mode still requires the expected
publisher certificate and timestamp. Unsigned mode requires a beta channel/version,
no certificate claim, and Windows reporting `NotSigned`; malformed or invalid
signatures do not trigger a fallback. Both paths check PE product/version and exact
artifact hashes, and both authenticate release metadata using Ed25519.

Receipts report `authenticode: "not-signed"` or `"signed"`. `ready` still means all
16 acceptance gates passed. Separate `unsignedBetaReady` requires the first 15 gates
to pass and gate 16 to retain a final-candidate-bound partial result with completed
local WinGet coverage and explicitly deferred Authenticode signing. Review tools
evaluate attributed evidence, not its contents, and do not launch tests themselves.

`publish-beta.mjs <review-config.json> <notes.md> <remote-commit-sha> <stage|publish>`
requires that release admission. It fixes the repository to Kubonsang/HoneyBee,
requires beta metadata and tag URLs, refuses an existing tag in stage mode, creates
a draft, uploads exactly the reviewed artifacts, downloads and rehashes them, then
only in publish mode promotes the matching draft to a prerelease. Unsigned notes
must contain `Windows Authenticode: not signed`. It does not overwrite assets,
promote fixture evidence, create a source commit or submit to WinGet. Interrupted
draft uploads remain drafts and require completion of the reviewed asset set.
No GitHub mutation has been performed for this ADR.

## Update signing key

`scripts/update/release-key.mjs` supports `create` and `export-public`. A new
Ed25519 key is protected by CurrentUser DPAPI with a versioned entropy value and
written exclusively into a directory created with a current-user-only protected
DACL. It refuses repository-local paths, redirects, alternate streams and existing
key files. The private PKCS8 material travels only over child-process pipes, is
not passed in command arguments or written as plaintext, and mutable buffers are
cleared. PowerShell errors are not included in Node exceptions containing key data.

The approved key was created at `%LOCALAPPDATA%\HoneyBeeRelease\release-v1.dpapi`.
Only its public key is in Desktop and the native host's compiled trust. The build
checks their equality; the recovery runtime copies the Desktop trust configuration.
Existing keys are never rotated on retry. `sign-release.mjs` can load `.dpapi`
keys as well as its previous explicit PEM input. The DPAPI key is tied to this
Windows user/profile; it is not a portable CI credential. Preserve that profile
and key file. A portable encrypted backup/cloud signing migration is separate from
this local prerelease tooling and must not replace the public key silently.

## Validation and remaining work

Four distribution-policy cases and two DPAPI key cases passed. The DPAPI cases
used disposable keys and verified signing, no plaintext storage and refusal to
overwrite. The native compiled-trust equality test passed. JS lint passed.

These are scoped implementation checks, not additional VM gates or final-release
qualification. Real service topology/SCM/boot recovery composition, combined update
dispatch and final Setup integration still need completion. Application Repair
coverage and its remaining limitations are described below.
No actual installed service was changed and no beta release has been published.

## Native topology connection

The bound paused service now exposes an internal reservation operation. It pins
the paused process across strict lease enumeration, validates retained-workspace
paths/SID/image identities, detects unaccounted attached store images, and compares
the intended volume with all local disk extents and mount paths. Unknown/corrupt
lease records are refused rather than omitted by the upstream ListLeases helper.
Pending/quarantined storage is refused before any detach. The protected topology
record is persisted before locks are acquired. Directory and image guards remain
held until reservation release; the ownership callback changes from paused-source
validation to machine exclusion only after the reservation succeeds, allowing it
to span the subsequent source process exit. The existing quiesce operation still
requires independent stopped-process proof before detach.

Topology enumeration has scoped fixture tests but has not been exercised against
the real QA VM's mounted disks. The continuation below adds broker-owned source
reattachment. Boot/paired-commit dispatch remains incomplete; this internal
operation is not a public migration CLI.

### Broker-owned restoration continuation (2026-09-14)

Reservation now cross-checks the retained record and workspace owner marker
against every lease before accepting its paths. Protected topology reload binds
the transaction and original service evidence and refuses malformed or duplicate
records. This does not infer missing ownership or rewrite file identities.

The actual managed broker service accepts an internal SCM StartService argument
sequence `maintenance-resume <transaction-sha256> <source-evidence-sha256>`.
Only the fixed ProgramData maintenance directory is read, with existing-directory
handles, administrator/System-only ACL validation, and no creation of a missing
record or maintenance directory. The source record binds the initiating SID,
workspace root, pipe and original service. Ordinary startup still uses no extra
SCM arguments. These are not executable command-line path arguments.

The startup adapter validates the complete current lease inventory, both ownership
records and child file identities before attaching anything. It refuses changed
or additional leases, changed file IDs and unexpected attachments of formerly
detached children. Only previously attached children are passed to the serving
broker's existing `attach-retained` implementation, so that broker owns the native
sessions after the maintenance process exits. Dynamic boot/PID/device evidence
may change on retry; workspace ownership may not. Failure leaves the service
unready and preserves journals and workspace files.

SCM initialization now occurs inside the service handler after StartPending, with
checkpoint reporting and a bounded cancellation path. Store recovery and mount
restoration complete before Running, the public pipe, or periodic recovery.
The bound source maintenance adapter can pass the protected resume identity to
SCM for a stopped broker; a still-paused broker continues in its existing process.
Reservation handles must be released before invoking this adapter.
After SCM reports Running, the bound adapter rechecks the full lease/ownership
inventory, file identities, actual loaded-image set, image-to-volume disk binding
and sole expected mount path while requiring the same running service PID. A
normal restart that omitted the resume arguments cannot pass merely by reporting
Running. These checks do not lock, dismount or detach an active volume.

Recovery arming now precedes Pause as well as Stop: otherwise a coordinator crash
between those controls could leave a paused broker with no registered recovery.
The adapter rechecks cancellation, SCM configuration and the same running PID
after arming and before Pause. Failed registration cannot disrupt the service.
The registration callback must be idempotent and verify its existing registration.

Stopped-source recovery now temporarily uses demand start, not automatic startup,
because StartService rejects Disabled services. It re-arms recovery before this
change. Automatic startup is restored only after Running and, for topology-aware
recovery, actual mount verification. Failed startup or failed mount validation
leaves demand start in place so that reboot must go through the recovery worker.
The protected original still records Automatic; observing demand start on retry
does not redefine the original configuration. Tests cover registration failure,
cancellation and PID change before Pause, plus successful/failed start ordering.
These ordering fixes do not implement the outstanding registration callback or
authorize use of an incomplete boot worker.

The native host package tests and `go vet .` passed. Added cases cover restoration
before serving, initialization failure/cancellation, formerly detached children,
unexpected attachments, ownership/file-ID/inventory mismatches, failed broker
responses, replay of dynamic attachment evidence, protected topology binding and
SCM argument forwarding. No installed service, real VHDX or QA VM was modified.
These checks do not add acceptance gates or replace the existing populated-store
and interruption qualification cases.

Still required: SCM StartService arguments are **not persisted across reboot**.
The protected boot coordinator must re-supply them after selecting recovery and
must remain armed while automatic startup could otherwise bypass that selection.
Actual replacement/rollback and boot registration are not connected yet. Legacy
hb12 does not provide the managed pause/resume capability; this change does not
make it eligible for live migration. Restoring a changed VHDX by replacement can
change its file ID and is deliberately refused until identity-preserving restore
or an explicitly validated rebind is implemented. The combined Desktop path,
general Setup upgrades and final beta publication remain unfinished.

### Native service file replacement and rollback continuation

`service_replacement_windows.go` adds the native file layer for the admitted
service host and receipt. It reauthenticates the protected release candidate,
derives the target receipt from the original machine/user binding, and stages a
separate private disposable copy so publication never consumes the authenticated
candidate. Copies are hash/size checked and flushed; disk headroom is checked
before staging. A durable pair record binds both files before either is moved.
The v1 path retains the original service configuration byte-for-byte under a
held read handle. It does not perform a config-schema or store-data migration.

Publication reuses the existing native per-file rename intents: preserve the old
file, publish its replacement, and replay either interruption boundary without
overwriting unrelated evidence. Only the two fixed installed component paths are
eligible. After publication the initiating SID receives read/execute access, not
write access, so normal-user Doctor can inspect the component; staged and saved
files remain under the private maintenance directory. This operation does not
start or enable the service. Its caller must still supply sustained process-exit,
disk quiescence, coherent backup and registered boot-recovery authority.

`service_replacement_rollback_windows.go` consumes the already published pair
record and independently authenticates the release metadata. Recovery does not
require the rejected candidate executable to remain intact. Per-file rollback
records distinguish untouched files, an absent target between renames, and a
published target. They persist that initial observation before restoring the
original. A damaged installed target is preserved under its observed hash before
the independently pinned original is restored. Retry consumes the original
rollback step rather than inventing a new baseline from a partially restored pair.
It never publishes a rejected executable merely to undo an interrupted rename.

The native host tests and `go vet .` passed. Real Windows file operations in
temporary directories covered interruption after host publication, pair retry,
conflicting retry refusal, failed journal/quiescence admission, rollback before
replacement, between host renames, after host publication, after both files,
damaged target preservation and interruption between rollback steps. Original
configuration and unrelated workspace-data fixtures remained unchanged.

These are internal native adapters, not a complete updater entry point. They have
not changed the installed service or a real Workspace. Protected boot-worker
registration/dispatch, target SCM startup, paired application commit and the final
integrated qualification remain outstanding. The full store restore/file-ID issue
above also remains separate from this component-only rollback. No acceptance gate
was newly marked passed and no beta release was published by these checks.

## Damaged active application Repair

Setup `/REPAIR` now attempts authenticated application reconstruction when ordinary
active-payload verification fails. It first verifies its own payload and the exact
matching installed Launcher, shim and recovery runtime. The Launcher must advertise
`applicationRepairGate: 1`. Setup then uses only its own code to stage the complete
approved active application, flush files, persist the Repair intent, and acquire
exclusive application activity before moving the damaged version to preserved
evidence and publishing the verified replacement. The activation pointer is unchanged.
Normal shared service Repair/Doctor runs only after the application passes verification.

The stable Launcher and managed Desktop/CLI refuse pending Repair intents. Launcher
startup invokes only its pinned `scripts/recovery/repair.mjs` entry to finish an
interrupted directory publication. Retry reuses the existing pending transaction;
unpublished staging directories do not authorize recovery. Both candidate and final
payload are verified against approved recovery inventories, and damaged bytes stay
under the Repair attempt rather than being deleted. Project state is outside the
version directory and is not copied or reset.

Isolated checks cover interruption after preserving the damaged directory, interruption
after publishing before completion, and candidate tampering refused before moving the
active application. The Launcher package tests, core compilation, JS lint and 32
Setup/distribution cases also passed. No manual VM run was requested.

This currently requires matching intact bootstrapper/recovery infrastructure. A
damaged Launcher/runtime, or a newer Setup whose infrastructure differs from the
installed initial recovery pin, is refused. General bootstrapper repair/Setup
upgrade composition and the final UI/VM journey remain incomplete. This is not
evidence that the entire Repair gate or release plan has passed.
