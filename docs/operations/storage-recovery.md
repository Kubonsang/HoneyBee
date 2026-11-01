# Storage recovery / 스토리지 복구

Open **Storage recovery / 스토리지 복구** in the title bar, or use the recovery button on Project setup. This works before any project is registered.

## Preserve existing work

Keep the installation, Workspace directories, registry, Library disks and Git branches. A component version mismatch alone is not an instruction to remove Workspaces. Do not delete `install-receipt.json`, use a different Windows account, or overwrite only the Desktop executable.

The recovery screen reads diagnostics; opening it never changes the service. It shows installed and required storage versions separately from receipt/owner validation. A valid receipt can pass while the component version fails.

## Setup-managed installation

1. Close Unity and tools writing into Workspaces, and save your work. Keep Workspace directories and branches.
2. In Storage recovery, choose **Check for updates / 업데이트 확인**. Download and prepare the authenticated release. Choose **Update & Restart / 업데이트 및 재시작** only when preparation succeeds.
3. If this path is unavailable, open the official Setup download page. Use the complete `HoneyBeeSetup.exe` at the **original installation path**, under the original Windows user. Setup is a separate, explicit user action; this recovery screen does not download or execute an EXE automatically.
4. A supported Setup upgrade authenticates the candidate, checks the source and performs the admitted service transaction with backup/recovery. A receipt belonging to another user/root or an unsupported old service must be refused before replacement.
5. Reopen Storage recovery and select **Check again / 다시 확인**. Continue project setup only after the checks pass.

**Important:** hb12 -> hb13/hb16 preservation is not established merely by adding versions to a compatibility list. If the original service/source cannot pass the supported migration preflight, keep all data and stop. Retain the diagnostic details, app version, installed/required component versions, installation path and original Setup version for a supported recovery. Do not use `install --replace` as a GUI fallback. This screen does not claim to implement a new legacy migrator.

## ZIP or development build

A new ZIP package may expect a newer machine-wide service. Use the original managed installation and its supported Setup update path. Do not copy individual new binaries into the old installation. If no managed installation exists, official Setup must diagnose the existing service rather than take it over.

## Installation record problems

A missing/corrupt receipt, missing/changed installed executable and a different Windows user are identity/integrity issues. Use the original installing account and matching Setup Repair. Keep the original paths and data. Repair does not grant permission to replace another installation.

## 한국어 요약

제목 표시줄의 **스토리지 복구**에서 설치 버전과 필요한 버전을 확인하세요. 같은 설치의 보존 업데이트를 사용하고, 업데이트가 거부되면 공식 Setup에서 **원래 설치 경로**를 선택하세요. 기존 Workspace와 브랜치는 유지합니다. hb12 같은 구형 서비스의 보존 전환은 실제 사전 검사와 검증을 통과해야 하며, 지원되지 않는 설치는 데이터를 보존한 상태로 중단합니다. 설치 기록 삭제나 무조건적인 서비스 교체로 우회하지 마세요.

## Qualification environment preparation

The current hb12 source does not advertise SCM Pause/Continue. The current combined migration refuses it before service mutation. A bridge requires separate implementation and preservation/rollback evidence; this UI change alone does not qualify that bridge or a public release.

An isolated Windows 11 26H2 guest subsequently verified the exact published beta.11 hb12 binary (`0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3`): `release` with `retainChild=true`, a normal source-service stop/restart, and `attach-retained` preserved synthetic authored, Library and external Bee file hashes plus the child file ID. The first synthetic parent lacked its required `Bee` directory; that failed seed and report were retained separately from the corrected successful case. This is a same-version mechanism probe, not cross-version migration, Git branch preservation or interruption/rollback qualification.

Native transaction preparation now has a guarded internal path for that exact published hb12 payload and a complete, detached retained inventory. It pins the original process, retains file/directory guards, compares complete lease journals before and after process exit, and refuses any mounted store image. A separately bound target topology requests reattachment while retaining the original detached snapshot for source rollback. The ordinary migration still requires Pause, and native admission still refuses hb12: this path is not publicly enabled or qualified.

The read-only Core planner also has an explicit `legacy-hb12-detached` option. It requires the original managed hb13 package helpers, the exact installed hb12 executable and receipt, the same canonical installation/Workspace root and a target that explicitly supports hb12 service replacement. It keeps activation disabled and records the remaining native admission/qualification gates. No CLI, Setup or UI caller enables this option yet. Finish source preparation and caller wiring, advance the component revision and regenerate manifests, then qualify the complete transaction before building a release candidate.

A fresh, disconnected Hyper-V VM can be prepared without reusing any retired QA VM:

```powershell
./scripts/qualification/new-storage-recovery-vm.ps1 -Mode Plan
./scripts/qualification/new-storage-recovery-vm.ps1 -Mode Plan -IsoPath 'C:/path/Windows11-x64.iso' -ExpectedIsoSha256 '<Microsoft-published SHA-256>'
```

Obtain Windows 11 x64 media from https://www.microsoft.com/software-download/windows11 and compare its Microsoft-published SHA-256. The Enterprise evaluation alternative is https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise. The operator must review the applicable license and complete Windows installation themselves; the script does not accept agreements, create accounts or configure credentials.

After reviewing the plan, run the same command in an administrator PowerShell with `-Mode Create`. It creates only `HoneyBee-StorageRecovery-20261101`, under `output/storage-recovery-vm-20261101/HyperV`, with a standalone dynamic 64 GiB disk, 4 GiB RAM, two CPUs, Secure Boot and virtual TPM. The VM remains off and disconnected. Existing VMs, host storage services, Workspaces, security settings and retired QA disks are not changed. The script refuses existing names/directories; failed partial creation is retained for inspection.

After manual Windows installation, name the guest `HB-RECOVERY38`, format its OS volume as NTFS and detach the ISO. Use the generated `release-vm-pin.json` with `release-vm.ps1`. The existing 38 GiB pause threshold, 22 GiB host reserve and 22 GiB guest headroom remain in force. Do not run service migration until the pinned guest capacity/admission and monitor are ready.

Before public beta.38, reproduce hb12 + beta.35/hb13 with synthetic Workspaces and branches in that guest, then qualify the bridge with authored-file and branch preservation, Library reattachment, source/target identity rejection, UAC cancellation, interruption/rollback and final Doctor checks. Do not import private host Workspace data into the fixture. Freeze exact Setup and manifest hashes and complete the existing release verification ledger before publication.

### Approved Quick Create gallery alternative (2026-11-01)

**Retired after inspection:** PowerShell Direct confirmed that this exact image reports Windows Enterprise Evaluation `LicenseStatus=5`, `LicenseStatusReason=0xC004F009` and `GracePeriodRemaining=0`. It must not supply qualification evidence. The helper now allows Plan only and refuses new extraction/creation to prevent repeating the expired-image setup. The steps below record the historical preparation, not a supported recommendation. The original host HoneyBee service/store was not changed.

The operator selected the Microsoft Quick Create Windows 11 gallery image and a separate budget for this new VM. ISO preparation is an alternative, not a prerequisite for this path. The official default gallery points to `WinDev2407Eval.HyperV.zip` (23,299,441,890 bytes), pinned by SHA-256 `b546c32894785dbaac07543d913bde9d6598972f76a440d6b5c00b2e73739684`. Its sole VHDX expands to 44,832,915,456 bytes (about 41.8 GiB). Source: https://download.microsoft.com/download/5/f/5/5f5197e8-7a9a-49dd-bd81-5d4bfa27d6a9/en-us/GalleryHyperV.JSON

Use `prepare-storage-recovery-gallery.ps1 -Mode Plan`, then `-Mode Prepare` only after the complete archive has been downloaded into the pinned output folder. Prepare locks and hashes the archive, checks its single-entry inventory, extracts to a new partial file and records the resulting VHDX hash. Partial files and existing artifacts are never overwritten.

`-Mode Create` requires administrator Hyper-V rights and refuses existing VM names/paths. It creates the same fresh VM identity as the ISO path, with a disconnected adapter, Secure Boot, TPM, no checkpoints and no automatic start. It leaves the VM **off**. Using this evaluation image is subject to Microsoft's Windows developer VM EULAs; review https://aka.ms/windowsdevelopervirtualmachineeula before first boot. Its age does not establish current evaluation validity: check the guest's actual activation/evaluation status before any qualification, and do not bypass expiration or alter its clock.

The `storage-recovery-gallery-20261101` capacity profile is restricted to this exact VM name/root and gallery archive hash. It allows a 64 GiB VM-file budget with a 60 GiB pause threshold. The normal 40/38 GiB profile and host/guest headroom requirements remain unchanged. Start the existing `release-vm.ps1 -Mode Watch` against the generated pin before first boot, and retain the monitor while preparing the guest. After boot, record the guest's actual computer name and fresh NTFS capacity observation before `-Mode Admit`. No guest service operation or public release is authorized by merely creating this VM.

Use the current [Microsoft Windows 11 Enterprise Evaluation ISO](https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise) for a replacement test OS. The EN-US 26H2 ISO offered on 2026-11-01 is 8,225,329,152 bytes; Microsoft's [published SHA-256](https://support.microsoft.com/en-us/servicing/os/windows/docs/2026/09/verify-the-authenticity-of-a-windows-11-enterprise-evaluation-iso-file) is `bc3f24086ebadc94489066b5ad78089e2cf5c3491e90e790bb81a2b199c10e38`. Verify the download before attachment. Installation/license acceptance remains an explicit user action. Reinstallation changes the disposable test guest account and OS, so never apply it to the host or a production Workspace disk. Check activation, guest clock and fresh capacity again after installation before admission.
