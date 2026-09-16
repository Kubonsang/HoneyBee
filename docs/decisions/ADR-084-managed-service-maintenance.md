# ADR-084: Managed service pause and protected migration inputs

Date: 2026-09-14

Status: Implemented native foundations; production migration integration incomplete.

## Broker maintenance boundary

The storage host's `broker-run` now uses a HoneyBee-owned SCM handler around the
existing upstream Broker and PipeServer. It adds Pause/Continue without modifying
the Go module cache. Existing pipe authentication, request handling, storage
operations and five-second background Recover stay in the upstream implementation.

Pause cancels the listening/recovery contexts, wakes the synchronous pipe listener,
and waits for both PipeServer.Serve and the background recovery loop to finish.
The upstream Serve cancellation path waits for its connection workers. Only then
does SCM receive Paused. The broker object remains alive and owns its disk handles.
A stuck client or recovery operation does not get a false pause acknowledgment.
Continue starts a new listener/recovery loop around the same broker object.

The native migration coordinator now requires PauseSource before ReserveDisks
inside the durable Reserving step. Stop requires the same process to be Paused;
it still arms recovery before disabling automatic startup and waits for the held
process handle after SCM reports Stopped. Resume can Continue a paused source
without recreating the process. Pause failure cannot reserve, stop or back up.

This is a service-host behavior change. An existing installed host without
AcceptPauseAndContinue is rejected for this migration path. Same storage component
version does not prove this capability. No legacy live-migration shortcut was added.
The actual supported source/target host builds must be chosen and qualified.

## Native release and candidate admission

The host verifies the existing exact-byte domain-separated Ed25519 signature.
`admitServiceRelease` additionally checks the release channel, app/bootstrapper
source floors, declared storage replacement source list, fixed repository package
location, signed inventory and fixed standalone host entry. It requires a signed
recovery inventory; hashes alone do not grant publisher identity.

The native source inputs must be derived from admitted installed state. Public
trust keys must come from a trusted build or protected policy, never a user request.
The policy returns the exact host SHA-256/size. It does not execute a candidate.

`stageServiceCandidate` authenticates before copying. It creates a private candidate
under the maintenance area, checks signed size while the source is held exclusively
and before output creation, then verifies the copied hash/size before publishing
its protected record. It retains manifest/signature/inventory for reauthentication
on restart. Reopening keeps verified candidate files held against replacement.
Interrupted unrecorded payloads are preserved; a retry uses a new private name.
A recorded candidate is reused only if the exact release inputs still agree.

## Protected source and migration records

`serviceSourceRecord` pins the original full SCM configuration, initiating SID,
source component evidence and transaction identity. The SCM connection now persists
this record before invoking its mandatory boot-recovery arming callback. The callback
must actually establish the recovery entry; persisting the source record alone
does not satisfy that requirement.

After restart, `openRecoveryMaintenanceService` uses the protected original config,
allowing only the expected temporary Disabled startup state. It never treats the
observed disabled state as the original policy. It verifies source bytes before
allowing source resume; changed/replaced files must first be restored by the
coordinator. Mount restoration remains a precondition for invoking resume.

Privileged journals use `maintenanceArea.createMigration/loadMigration`, with
directory and files created using the private owner/protected DACL from birth.
State records are synced and renamed exclusively; failures do not advance the
in-memory state. Loads validate private file permissions and bounded hash chains.
The older filesystem factory remains for isolated coordinator tests and must not
be used to authorize privileged production operations. Private journal handles
must remain open while operating and be released through closePrivate afterward.

## Validation and limits

The storage host root package passed 238 tests/subtests with no failures after the
changes. The run used fixture files and fake SCM controls. Windows file-handle
tests needed the sandbox restriction lifted; there was no actual service mutation.
Raw final log:

`output/verification/native-maintenance-5ea9a99b920a49b38fad18b322c91205/go-test.jsonl`

Coverage includes simultaneous request/recovery drain, pause/continue, legacy
capability refusal, pause-before-reservation ordering, source settings replay,
signed policy refusal, candidate identity/size admission, protected journal
publication failures and the existing restore tests. Go vet also passed during
this work. These passes do not establish real SCM Pause/Continue or boot recovery
qualification, nor do they complete the fixed 16 final acceptance gates.

## Remaining production connections

- Complete mounted-volume topology capture, reserved-handle validation and recovery
  ownership handoff for the designated real service pair.
- Register and execute the protected boot recovery entry before inhibiting startup.
- Connect private candidate publication, whole-store rollback, SCM target startup
  and protected paired commit to the user-level combined coordinator.
- Finish authenticated damaged-app Repair and final installer composition.
- Configure approved production release keys and the Windows signing provider, then
  assemble and qualify the single final candidate under the existing 16 gates.

The current user certificate store had no code-signing certificate when inspected;
Desktop production trust still contains an empty publicKeys array. Test fixture keys
must never be substituted. The user has been asked for public trust/provider details
and the actual supported service build pair; private keys/passwords were not requested.
