# ADR-081: Reserve volumes before stopping the service

Date: 2026-09-14

Status: Internal native mechanics and backup verification implemented; not connected
to automatic service migration. None of the six remaining workstreams is declared
complete by this change.

## Source lifetime and ordering

The pinned storage dependency's `virtualDiskAttachFlags` requests no drive letter
but does not request permanent lifetime. Its service shutdown cancels the pipe and
background recovery; it is not a nondestructive maintenance protocol. Opening an
existing `storage.Attachment` also does not set the private `attached` flag, so its
`Detach()` method cannot be used to detach a pre-existing service attachment.

This makes ADR-080's stop-before-volume-reservation sequence insufficient. Capture
the original topology durably and acquire all admitted image/volume handles and
exclusive volume locks before allowing the service process to exit. Keep those
handles across the SCM stop. Only then explicitly detach, confirm the image is no
longer loaded, close native handles and acquire exclusive backup file handles.

```text
Prepared -> Reserving -> Reserved -> Stopping -> Stopped
 -> Quiescing -> Quiesced -> BackingUp -> BackupVerified
 -> Replacing -> Replaced -> Validating -> ReadyForAppCommit -> Committed
```

New migration identities use protocol 3. Protocols 1 and 2 are refused rather than
reinterpreting their journal semantics. Reserving/Reserved failures take the same
idempotent source-resume path as other pre-replacement failures. No production
migration has been enabled for any of these protocols.

## Native operations

`openMaintenanceVolume` opens an admitted VHDX with GET_INFO and DETACH access. It
resolves the image's physical disk number and independently checks the volume's
single complete disk extent. Noncanonical volume GUIDs, multi-disk/truncated
extent responses, and mismatched disks are rejected before locking/dismounting.

`reserveMaintenanceVolumes` requires durable resume information and locks every
volume before returning a reservation. A busy volume releases the acquired handles
without detaching another image. `quiesce` additionally requires stopped-service
proof; it holds locks through dismount/detach, checks `GET_VIRTUAL_DISK_INFO_IS_LOADED`,
and closes handles on success or partial failure. There is no force retry, mount
deletion, image deletion or formatting operation.

These are mechanics, not a privileged admission factory. The final caller still
must validate the actual service, enumerate every volume and image, hold protected
path guards, exclude all app/broker writers, bind durable resume records, and supply
real stopped-service/ownership checks. Tests using fake callbacks are not proof of
those properties. No CLI exposes these functions.

## Backup consumption

`verifyColdBackup` requires a pinned bounded manifest and exact file inventory.
Names, hashes, sizes, directory topology, reparse points, hard links, extra entries
and missing entries are checked. File data is hashed as a stream. Verified file and
directory handles remain held until consumption ends, preventing modification or
replacement of the verified bytes. The protected maintenance owner must still
exclude new entries and establish completeness of the service recovery unit.

This verifier does not reconstruct SCM state, permissions or mounts and does not
claim `recoveryReady`. Complete store inventory, protected output ownership,
restoration, and real service integration remain required.

## Protected backup output integration

`maintenanceArea.captureBackup` now routes the existing streaming cold-copy engine
through a protected output factory. The root, each intermediate directory, each
payload file and `manifest.json` are created relative to held maintenance handles
with explicit protected ownership/DACLs. `FILE_CREATE` refuses existing output;
no existing backup is overwritten and no post-copy permission repair is relied on.
Every creation rechecks maintenance ownership and caller-supplied quiescence.

The ordinary-file test helper and protected path share the copy, capacity, hashing
and manifest logic. Tests check that manifest creation cannot bypass the selected
factory, that creation failure preserves partial payload without a manifest, and
that an unopened maintenance area cannot create output. The storage-host root
test suite and `go vet .` passed. Actual elevated NT object creation remains for
the fixed integrated qualification; these tests do not claim that coverage.

Protected backup creation is connected internally, but original-file restoration,
SCM restoration, complete source inventory and signed privileged admission are
still unimplemented. Automatic service migration remains disabled.

## Restore candidate preparation

`maintenanceArea.stageRestore` now consumes a hash-pinned backup through retained
verification handles and prepares a separate protected candidate using the same
output factory as backup capture. It checks space for all logical file bytes,
manifest and headroom before creation, streams and syncs every file, writes the
identical manifest last, and verifies the entire resulting candidate again.

A complete existing candidate can be reused only after full revalidation against
the backup pin. An incomplete or changed candidate is refused and retained. A
fresh named attempt can proceed without deleting previous evidence. Source overlap
and released backup handles are refused before creating output. This stage never
overwrites installed files or updates SCM state.

Tests cover completed-candidate reuse, changed-candidate refusal, interruption
before manifest publication, preservation of the partial attempt, successful fresh
retry, original backup preservation, overlap and closed-handle rejection. The root
storage-host test suite and vet passed after this integration. Actual elevated
creation and service restoration still await the fixed integrated qualification.

Remaining: complete store/SCM/mount inventory, publication of restored files with
original permissions, service/mount restoration, signed privileged admission and
the other approved workstreams. Preparing a candidate is not a completed rollback.

## Service stop and pre-replacement resume adapter

The internal `maintenanceService` adapter now preserves the full observed SCM
configuration and admits only that configuration or its disabled-start variant.
The native mutation changes only start type with `ChangeServiceConfig`; it does
not replay account, dependency or service-SID settings.

Before disabling startup, stop requires source-file verification, a held process
handle matching the source executable, and a successful durable recovery-arming
callback. After disabling startup it rechecks the process identity, requests stop,
waits for SCM Stopped and then waits for the original process handle to signal exit.
Timeout, unexpected configuration and changed process identity fail without a
force-kill fallback. These waits are bounded to 30 seconds.

Pre-replacement resume revalidates source files before restoring the original
automatic-start policy and starting the stopped source. An already running source
is not restarted. Source health and mount restoration remain separate mandatory
coordinator responsibilities; Running alone is not complete recovery.

Tests use fake SCM state and the test process's own read-only process handle. They
cover operation ordering, failed recovery arming, changed executable/configuration,
process replacement, process-exit failure, repeated resume and cancellation. Root
Go tests and vet passed; no live service was stopped or reconfigured.

No production constructor/CLI exposes this adapter yet. The protected admission
factory, durable boot-recovery arming implementation and full source-file verifier
must supply the required authorities before use. Actual file publication, SCM
rollback after replacement and mount restoration remain outstanding; the adapter
does not silently satisfy those missing pieces with no-op callbacks.

## Source evidence binding

`withSourceEvidence` now binds the SCM adapter to the original command/account/type/
startup identity and a concrete `maintenanceSource` verifier. The verifier reuses
receipt/config/command validation and compares all three component hashes with the
pinned source evidence. It holds ordinary read handles denying writes and deletion,
plus ancestor directory guards, for the entire stop or resume operation. Closing
the operation releases these handles so later exclusive backup/replacement can
proceed. A subsequent resume must obtain fresh matching source evidence handles.

Tests cover held-file write refusal, released-handle refusal, unrelated SCM identity,
changed executable refusal and stop-to-resume binding with fake SCM. Root Go tests
and vet passed. The source guard protects only the three component files; it is
not whole-store backup admission, a boot recovery implementation, or permission to
replace live files. Those integrations and the remaining workstreams are pending.

## Store inventory and capture connection

`inventoryColdStore` now enumerates bounded store-relative entries, including root
and empty directories, ordinary file size/hash, attributes, and owner/group/DACL
descriptors. Reparse points and hard-linked files are refused. Only the root-level
maintenance directory is excluded; Workspace/project trees outside the store are
not traversed. Read handles and directory guards are retained during enumeration.

`maintenanceArea.captureStoreBackup` writes the inventory through a protected
exclusive native file creation, captures that metadata plus `store/` payloads with
the shared cold-copy engine, verifies the candidate, compares every payload with
the inventory, verifies the metadata hash, and re-enumerates the store to detect
changes during capture. Failed attempts and their metadata remain as evidence.

Tests cover root/empty directories, security descriptor capture, maintenance
exclusion, content comparison, incomplete backup and hard-link refusal. Root Go
tests and vet passed. Actual privileged capture remains unqualified on a populated
service store. This is still not `recoveryReady`: SCM/mount topology, restoration
and final admission are missing. Data-stream/attribute policy (including alternate
streams and special NTFS attributes) must be made explicit before enabling the
production path; current copying handles ordinary unnamed file bytes. SACL audit
policy is neither captured nor changed by these helpers.

## Restore metadata and NTFS admission

Store capture now checks each opened object with `FileStreamInfo` and an attribute
allowlist. Named data streams, compressed/encrypted/offline/reparse and unknown
attributes are refused rather than silently omitted. Ordinary sparse-file bytes
remain supported using logical-size capacity admission; sparse allocation is not
preserved by staging. Directory named streams are checked too. Stream enumeration
errors do not mean no streams.

`readStoreRestoreInventory` consumes only held, verified backup metadata. It bounds
and strictly decodes the JSON, requires a root directory and all parent entries,
rejects duplicate/case-aliased paths, traversal and maintenance-subtree targets,
validates owner/group/DACL and supported attributes, and matches all file hashes
and sizes against the backup manifest. Store capture validates this contract before
writing metadata, and protected restore staging requires it before creating output.

Tests include real alternate streams on temporary files and directories, unsafe
recovery metadata, pinned metadata/payload matching and closed backup refusal.
The complete storage-host root tests and vet passed. No manual VM case was added.

References: [Microsoft FILE_STREAM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info).
Actual installed-file publication, restoration of permissions/attributes and
service/mount topology, boot recovery admission, and the later workstreams remain
pending. These admission checks do not mark any of the six workstreams complete.

## Interrupted file restoration mechanics

`applyRestoreFile` now implements a single changed-file content step using held
native file/directory handles and exclusive, non-replacing NT renames. It hashes
the target, candidate and preservation path before mutation. Only three states
are admitted: initial; original moved aside with candidate remaining; candidate
applied with original preserved. Other combinations fail without overwriting them.
The protected intent callback must bind all paths and both hashes before any
rename, and verify that binding on replay. Service-stop/ownership checks surround
mutation. The preserved file is never automatically removed.

Actual NT rename tests use separate temporary directories and cover interruption
after preservation, successful replay, repeated completion, unknown target,
occupied preservation path, busy target and failed intent persistence. Root Go
tests and vet passed. No installed file or running service was changed.

This function is internal mechanics, not a privileged restore entry. Admitted
fixed-store path construction, protected durable intent implementation, permission
and attribute restoration, full inventory sequencing and SCM/mount recovery remain
required before production wiring. Its callbacks are not supplied with no-ops by
any production command. A successful file-content step is not whole-service rollback.

## Protected per-file intent connection

`maintenanceArea.applyRecordedRestoreFile` now supplies actual protected intent
storage to the native file step. Targets must be inside the admitted service store
and outside maintenance; candidates and preserved files must stay inside maintenance.
Native held-path checks still refuse redirects and aliases before mutation.

Intent identity is keyed by transaction and target, while the immutable content
binds all three paths and both hashes. A changed candidate or hash conflicts with
the existing record. New records are written/synced to exclusively created protected
partial files, atomically renamed without replacement, closed and read back before
file mutation is authorized. Partial records are preserved and never replay authority.
Only the temporary intent handle receives the extra DELETE access required to rename;
ordinary maintenance creation does not gain it.

Tests exercise native publication, interrupted publication with retained partials,
idempotent replay, conflicting paths/hashes, path boundaries and interrupted native
file restoration using a real persisted intent in temporary storage. Root tests and
vet passed. Privileged ProgramData creation is not claimed as tested by those cases.

This supplies per-file intent persistence, not signed privileged admission or the
boot recovery entry. Full-store ordering, permissions/attributes, unchanged/new/removed
file policy, SCM/mount reconstruction and later workstreams remain incomplete. No
automatic service migration or user-facing privileged command was enabled.

## Validation boundary

### Connected cold-store restore backend (2026-09-14)

`store_restore_execute_windows.go` connects the recorded coordinator to native file
restoration, missing-directory publication, obsolete-directory preservation and
identity-bound metadata restoration. Each invocation revalidates the pinned immutable
backup and source inventory, then compares the final live inventory exactly with the
source. It remains internal: completion neither starts SCM nor restores mounts or
commits an app/service migration.

Missing directories are prepared under protected preservation scaffolding before
their identity is recorded and they are published without overwrite. Publication
replay admits a populated target only when its native identity matches the intent.
Directory intent schema 2 binds the operation (`publish` or `preserve`); older intents
fail closed. Original directory metadata is applied parent-first and file metadata
last. Metadata intents bind the full entry, target identity and source inventory hash.

Metadata restoration now sets a required sparse flag with `FSCTL_SET_SPARSE` after
intent persistence and logical-byte verification. It never clears an unexpected
sparse flag and does not recreate allocation holes; staging capacity remains based
on logical size. Read-only completed files can be verified on replay without clearing
their attributes. If a mutation lacks a writable handle, it still fails closed.

A native temporary-store composition test includes missing directories/files,
changed and unchanged files, post-backup files and nested obsolete directories. It
interrupts after a file operation, resumes twice, compares final source inventory
and checks that post-backup bytes remain preserved. The combined fixture also
contains read-only and sparse files. Separate native tests cover
populated-directory publication replay, directory ACL restoration, sparse metadata
and read-only file replay. The integrated test uses current-user temporary paths and
does not exercise the privileged ProgramData factory or identity-bound metadata
adapter in production. No real VHDX/service migration or new VM gate is claimed.

Remaining work includes elevated ownership/privilege behavior, complete writer and
mount topology admission, SCM/boot recovery composition and actual signed target
service admission. The six-workstream objective remains incomplete.

The pinned upstream `workspace/service_windows.go` still runs `Broker.Recover` on
a five-second ticker and exposes only stop/shutdown control. `Broker.Recover` can
quarantine pending work and release non-retained leases. Desktop/CLI drain alone
therefore must not be promoted to proof of broker quiescence. A future service host
maintenance boundary (or equivalently proven source-specific admission) must cover
both pipe handlers and background recovery before pre-stop topology reservation.
No module-cache file or installed hb12 service was changed for this investigation.

### Native obsolete-directory preservation (2026-09-14)

`restore_directory_windows.go` preserves an obsolete empty directory using held
native parent/directory handles and non-overwriting rename. It records the transaction,
both paths and volume/file identity before moving. Replay requires the existing intent
and the same directory identity; an unrelated empty directory is not sufficient.
Contents are inspected through the held handle, with bounded enumeration. Nonempty
directories, ambiguous presence and occupied preservation slots fail closed.

Preserved directories use flat unique slots, allowing child-first preservation and
replay after the original parent has also moved. `maintenanceArea.preserveRecordedDirectory`
binds the entry to the loaded whole-store record, fixed store and protected preservation
scaffolding. This does not remove directory contents or follow reparse points. Writer
exclusion remains mandatory because a directory handle does not lock its descendants.

Native temporary-directory tests cover parent/child replay, interruption after rename,
substituted identity, nonempty/occupied targets, missing intent and publication failure.
Root Go tests and vet passed. The elevated maintenance adapter is not qualified by
these temporary-directory cases. Missing-directory creation, directory metadata and
the full service/mount restore composition remain incomplete; no automatic migration
entry point or new manual qualification gate was added.

### Protected whole-plan persistence (2026-09-14)

`store_restore_record_windows.go` now records the complete initial target inventory,
source inventory, derived plan and transaction identity before coordinator execution.
Identity binds the fixed store root, backup manifest hash and distinct backup,
candidate and preservation names. The transaction selects one record filename, so
changing a backup hash or location conflicts rather than creating new authority.

The shared bounded record publisher writes and syncs a new protected temporary file,
publishes by non-overwriting handle rename and verifies the published bytes. Partial
files remain evidence and cannot be loaded as plans. Whole-plan records are bounded
at 64 MiB; individual file intents retain their 64 KiB bound. Both use the same
maintenance owner/DACL and exclusive native creation primitives.

`maintenanceArea.prepareStoreRestore` reads a verified pinned backup and observes the
stopped store only when no published record exists. Restart loads and validates the
original inventories and recomputes the plan for comparison; it does not recapture
partially restored files. Unknown fields, trailing JSON, malformed inventories and
plan differences fail closed. `executeRecordedStoreRestore` rereads the durable
authority before invoking any mutating adapter.

Temporary-file tests cover native atomic publication, retained interrupted partials,
restart without reobservation, changed backup/candidate refusal, corrupt/truncated
records and coordinator refusal before mutation. Root Go tests and vet passed.
Privileged ProgramData creation remains unqualified; directory, SCM and mount
adapters are still required before enabling automatic service migration. This change
does not add a manual VM bundle or acceptance gate.

### Inventory-wide restore ordering and file presence (2026-09-14)

`store_restore_plan_windows.go` derives a deterministic plan from the pinned source
inventory and the durable observation of the stopped target. Both complete inventories,
including permissions and attributes, are hashed independently of enumeration order.
The target observation must not be recaptured after a partial restore. A missing
file at that point may be an interrupted rename, rather than original absence.

The coordinator requires plan persistence before mutations, creates missing parents
first, restores files, preserves obsolete directories child-first, applies directory
metadata parent-first followed by file metadata, and verifies the complete source
inventory last. Every adapter is mandatory and errors stop the sequence. File versus
directory conflicts and case-only path changes fail before persistence. Neither the
coordinator nor its successful return starts the service or commits application state.

The native file primitive and its existing protected intent now also handle an
inventory-proven missing target, a file introduced after backup, and unchanged bytes.
Post-backup files move to the preservation location; they are not deleted. Missing
files are published without overwriting anything. Unchanged files retain their staged
copy and still require intent verification before metadata restoration. Unexpected
target/candidate/preserved identities are refused. Native temporary-file tests cover
these cases, interruption and repeated replay with real persisted file intents.

This is not yet the production whole-store restore adapter: protected whole-plan
persistence, directory creation/preservation/ACL adapters, sparse preparation and
post-metadata reopening remain to be connected. Coordinator failure tests use injected
adapters; they do not qualify privileged directory operations. The existing fixed
acceptance gates remain unchanged.

### Held-file metadata restoration (2026-09-14)

`restore_metadata_windows.go` adds an internal file-only step that rechecks logical
size, SHA-256, single-link identity and stream policy through the caller's held
handle before applying owner, group, DACL protection and ordinary attributes.
The caller must provide admitted paths, a pinned inventory, exclusive handle rights,
service exclusion and durable intent binding the complete metadata to that target.
Intent failure prevents mutation. Security and attributes are read back exactly;
access denial or inheritance differences fail closed. Partial application can be
retried using the same authority. No public command invokes this primitive.

Sparse state must already match; this step does not clear sparse allocation or
pretend a logical-byte copy recreated holes. Directory ACL ordering, durable metadata
intent storage and reopening after partial restoration still need integration.
SACLs and timestamps remain outside this backup format. Service startup remains
blocked until the wider restore and health protocol is complete.

Native temporary-file tests cover changed DACL protection, read-only/hidden attributes,
repeat application, interruption after security application, and refusal for changed
bytes, failed intent, missing service exclusion, sparse mismatch and SACL metadata.
The root Go tests and vet passed outside the restricted filesystem sandbox. This
does not qualify privileged ownership restoration under SYSTEM or the production
ProgramData factory, and adds no manual acceptance gate.

Automated checks cover invalid volume identities and extents, lock-before-detach
ordering, a reservation spanning service stop, busy-volume refusal, partial-detach
cleanup, durable-record failure, journal interruption/resume, and changed or
incomplete backup refusal. Backup handle tests use ordinary temporary files.

Native Win32 VHDX calls are compiled but have not been exercised on a real VHDX in
this change. The existing final integrated qualification remains the place for
that evidence; this does not add a manual VM bundle or acceptance gate.

## References

- [Microsoft: FSCTL_SET_SPARSE](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_sparse)

- [Microsoft: FSCTL_LOCK_VOLUME](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_lock_volume)
- [Microsoft: OpenVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-openvirtualdisk)
- [Microsoft: DetachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-detachvirtualdisk)
- [Microsoft: GET_VIRTUAL_DISK_INFO](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-get_virtual_disk_info)
