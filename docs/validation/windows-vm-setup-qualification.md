# Windows VM setup qualification

Status: **PARTIAL — guest installation and Doctor readiness observed**. A new dedicated Hyper-V
VM `HoneyBee-Setup-QA-20260910` was created and started on 2026-09-10; its VMConnect
console was opened for Windows installation. VM ID:
`a4693938-ec51-4427-a453-1e44739d7db2`. Configuration: generation 2, 4 GiB RAM,
2 processors, dynamic 64 GiB disk, Secure Boot and virtual TPM. Automatic checkpoints
are disabled. Evidence: `output/vm-qualification/vm-created.json`.

The Windows 11 Enterprise 25H2 x64 en-US evaluation ISO was downloaded through the
[Microsoft Evaluation Center](https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise).
Its SHA-256 matched Microsoft's published PDF:
`a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9`.
ISO, hash PDF and VM files are under `output/vm-qualification`. HoneyBee service installation is now observed in user-supplied guest evidence. No existing host service or project was changed.

Artifact under test: `HoneyBeeSetup-preview.exe` from `output/setup/build-C1komL`.
SHA-256: `dfd92697da034126eaf2aa851a69ee84903f52260b003e37e28ee7c252b97b94`.

## Observed guest results (user-supplied evidence)

The user reported that Windows installation completed and HoneyBee launched after
approving UAC. The intended cancellation step was not performed: typing `NO` into
PowerShell did not cancel the Windows UAC prompt. Do not count this as cancellation
or retry coverage.

The subsequent Baseline collector run at `2026-09-10T13:59:39.1302125Z` correctly
failed because HoneyBee was already installed. It nevertheless captured the pinned
Setup hash, guest `DESKTOP-9LT0JVV`, Windows Enterprise Evaluation build 26200, a
running automatic LocalSystem service, and an installation receipt whose SID matched
the collector's initiating SID. Setup health reported `ready: true` and
`serviceAction: installed`. This is post-install evidence, not a clean baseline.

The first user-supplied Doctor output had 11 passes, one warning and one failure:
Git was missing. After installing Git for Windows, the user supplied a second
Doctor output with **ready=true, 12 passes, one warning, zero failures**. Git was
`2.55.0.windows.3`; private Node was `24.13.1`. Package integrity, service status,
receipt, component compatibility, Workspace root access and storage responsiveness
all passed. The only warning was that no Unity project was registered.

The user explicitly confirmed that the second Doctor run occurred after rebooting
the VM. Service automatic startup and post-reboot Doctor readiness therefore pass
based on user-confirmed guest evidence. Independent boot-time capture and full guest
report export are not yet available. UAC screenshots, cancellation, alternate
credentials and interruption tests remain outstanding.

Fresh-install UX finding: setup's service-only health can report ready while Doctor
fails for missing Git. The final installer needs Git prerequisite detection and a
clear installation/remediation flow; successful service health alone is not full
application readiness. ADR-041 subsequently adds the shared Git prerequisite probe to Setup; the guest
evidence above still describes the earlier pinned artifact.

## Guest preparation

Use a disposable Windows 11 x64 VM with UAC enabled and supported local NTFS
storage. Keep a powered-off clean checkpoint before each independent scenario.
Copy the setup and `windows-setup-evidence.ps1` into the guest. Run the collector
from an unelevated PowerShell as the account that will start setup. Use a separate
evidence folder for each scenario. Export evidence and screenshots before reverting.
Never revert an existing development VM without confirming it is disposable.

The collector reads service state, receipt, ACLs, health and native diagnostics. It
only writes evidence files, refuses a different computer name or an elevated token,
and never installs/removes services. It publishes each phase report exclusively.
A report's `passed` field covers its snapshot assertions, not the entire matrix.

Example inside the intended guest (replace `HB-TEST` with its real computer name):

```powershell
.\windows-setup-evidence.ps1 -Phase Baseline -ExpectedComputerName HB-TEST -EvidenceDirectory C:\Evidence\approval -SetupPath C:\Test\HoneyBeeSetup-preview.exe
```

Start the Setup interactively as the same user. Do not use `/S`: that deliberately
skips UAC. Complete the specified UAC action manually; do not disable secure desktop,
UAC or credential prompting to make the test pass. Afterwards use the same command
with `-Phase Installed` or `-Phase Cancelled`.

## Required scenarios

| Scenario                       | Action                                                                                         | Required evidence                                                                                                                             | Result                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Consent                        | Clean admin-account baseline; start setup unelevated; approve UAC                              | UAC screenshot, Installed.json, original SID in receipt, running LocalSystem service, matching binary hash, ready health, Desktop launch      | Not run                                                           |
| Cancellation                   | Fresh checkpoint; cancel UAC                                                                   | Cancelled.json, explicit cancellation, no service/receipt, app and journal preserved                                                          | Not run                                                           |
| Retry                          | After cancellation, rerun identical interactive Setup and approve                              | Installed.json, same initiating SID, app inventory unchanged, one successful service install                                                  | Not run                                                           |
| Alternate credentials          | Fresh checkpoint; initiate as standard user and enter a different administrator account in UAC | Installed.json collected by original standard user, receipt SID equals that standard user, ACLs and Workspace access verified under that user | Not run                                                           |
| Reboot                         | After successful install, reboot guest and log in as original user                             | Service automatic startup, post-reboot health/Doctor output, CLI/Desktop launch                                                               | Passed: user confirmed reboot; Doctor ready=true, service running |
| Interrupted privileged install | Fresh checkpoint per interruption point; terminate/reboot during installation                  | Receipt/config/binary/journal evidence, no silent replacement or data deletion; recovery state reported                                       | Not run                                                           |
| Existing service               | Separate disposable fixture with existing mismatched service/receipt                           | No replacement or ACL mutation; setup reports blocked; compare before/after bytes and ACLs                                                    | Not run                                                           |

Collect Desktop screenshots, journal files from `.setup-pending`, and
`bin\honeybee.exe doctor --json` output separately. The collector records diagnostic
snapshots; it does not independently prove all ACL access semantics or Doctor
readiness. Git and other prerequisite failures must be recorded, not hidden by
marking service-only health as complete application qualification.

Local validation completed for the collector: PowerShell parser check and wrong-
computer guard rejection before evidence-directory creation. Actual guest execution
has begun; see the user-supplied results above for completed and outstanding gates.
