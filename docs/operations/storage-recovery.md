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

**Important:** legacy preservation is not established merely by adding versions to a compatibility list. If the original service/source cannot pass the supported migration preflight, keep all data and stop. Retain the diagnostic details, app version, installed/required component versions, installation path and original Setup version for a supported recovery. Do not use `install --replace` as a GUI fallback. The released Setup must explicitly support the source installation; the diagnostic screen itself does not perform service migration.

## ZIP or development build

A new ZIP package may expect a newer machine-wide service. Use the original managed installation and its supported Setup update path. Do not copy individual new binaries into the old installation. If no managed installation exists, official Setup must diagnose the existing service rather than take it over.

## Installation record problems

A missing/corrupt receipt, missing/changed installed executable and a different Windows user are identity/integrity issues. Use the original installing account and matching Setup Repair. Keep the original paths and data. Repair does not grant permission to replace another installation.

## 한국어 요약

제목 표시줄의 **스토리지 복구**에서 설치 버전과 필요한 버전을 확인하세요. 같은 설치의 보존 업데이트를 사용하고, 업데이트가 거부되면 공식 Setup에서 **원래 설치 경로**를 선택하세요. 기존 Workspace와 브랜치는 유지합니다. hb12 같은 구형 서비스의 보존 전환은 실제 사전 검사와 검증을 통과해야 하며, 지원되지 않는 설치는 데이터를 보존한 상태로 중단합니다. 설치 기록 삭제나 무조건적인 서비스 교체로 우회하지 마세요.

## Preserving legacy recovery (hb17 candidate)

The new Setup has an explicit preserving path for the reproduced public beta.35 installation whose package expects hb13 but whose installed service is the exact published hb12. It authenticates the original launcher, recovery runtime, application files, Windows user, installation root and service executable. A missing/changed receipt, another user's installation or an unknown source is refused. This is not a general `install --replace` fallback.

Close Unity and Workspace tools, then run the complete supported Setup interactively at the original path under the original account. It prepares the authenticated target, requests the usual Windows service-update elevation, locks retained Workspace volumes, and performs the protected update with cold backup and recovery. It preserves Workspace directories, Git branches, Library and Bee data. An open file blocks the volume lock before the old service is stopped.

If interrupted, rerun the same Setup version. Setup finds the bound pending transaction and resumes its recovery rather than starting another service transaction. A restored hb12 baseline remains explicitly unready for Workspace use until a preserving update succeeds. Keep the evidence and existing data if authentication or recovery refuses to continue.

This repository's hb17 implementation is still a release candidate. Do not treat a compatibility declaration, UI screenshot or source-test pass as complete cross-version qualification. Freeze the signed Setup/application artifacts and verify actual replacement, cold backup, owner rejection, cancellation, interruption/rollback, final Doctor and normal launch before public release.

## Mechanism evidence

The isolated licensed Windows 11 26H2 VM reproduces the original public beta.35 package, unchanged published hb12 service and a retained synthetic Workspace with a real Git branch. Initial read-only planner tests preserved receipt, authored-file and lease bytes.

An important negative probe found that old hb12 retaining release succeeded even with a file open. That operation is not used for automatic preparation. A later kernel-volume-lock probe refused the open file, then held a lock across normal original-service exit and disk detachment. Restart/reattachment preserved authored, Library and external Bee hashes, the original child file ID and Git branch. A product-code reservation-only probe also passed busy refusal, durable topology checks and unchanged original service PID/attachment and data.

The new transaction retains the original live topology for the target, and a separate detached retained topology for hb12 rollback. Cancellation before stop may verify an unchanged running topology. Recovery intent and source observation are bound into protected native records. Additional user-side recovery metadata preserves the original strict bootstrapper context format. Original hb12 startup is never given unsupported maintenance-resume instructions.

These mechanism probes did not replace the service and do not qualify the final release artifacts. Production host services and Workspaces were not modified by these tests.
