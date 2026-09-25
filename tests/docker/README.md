# Docker-first verification

For all future candidates use the [unified release procedure](../../docs/operations/release-verification.md).
`node tests/docker/run.mjs` is the common local/CI runner; `run-wsl.ps1` remains a
compatibility wrapper. New evidence uses `output/verification-docker-*`, a dedicated
BuildKit builder and source-bound receipts. The issue46 paths and counts below are
historical evidence, not the current qualification state.

The default runner now selects `-Suite portable`: all discovered Vitest and
Node contract suites, Python VHDX-analysis fixture tests, and Linux-buildable Go
tests (including the hash-verified hb15 upstream overlay) with race detection and
vet, plus pure PowerShell qualification-function tests. It also runs source secret
scanning, license, formatting, lint, typecheck, build and dependency-boundary checks.
Use `-Suite contract` for the original focused 41-test heartbeat/tool-pair lane.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/docker/run-wsl.ps1
```

The portable lane is **not** a Windows acceptance lane. Existing explicit
Windows-only test skips remain visible; `go list -json` records ignored Windows
source/test files. Python tests analyze fixture bytes, not mounted native VHDX
volumes. Go tests exercise portable workers and fake providers, not Windows SCM
or NTFS. A green aggregate requires every stage to succeed, but skipped tests
are never promoted to native passes.

The host runner stages a hash-inventoried source context from Git's tracked and
non-ignored task files. It never copies the host `.git`, `output`, VM disks,
dependency trees or credentials. Docker applies a second source allowlist. The
portable runtime is a non-root user, with no network or bind mounts, 4 GiB memory,
2 CPUs and 512 PIDs. Build-time downloads are allowed; the Node/Go image digests,
PowerShell image digest, pnpm version, lockfile, upstream module checksum and overlay hash are pinned.
System packages are installed from Debian repositories at build time.

The container exposes real Linux Git under the `git.exe` name used by the
Windows application. Filesystem fixtures use host-platform absolute paths and
ignore either a directory junction or a symlink. These tests retain their actual
Git/filesystem operations; they do not emulate NTFS or prove Windows junction
semantics. Doctor tests still require Linux to report `system.windows` failure.
Windows-only cases use explicit per-case platform gates, not whole-suite removal.
Their bodies remain enabled on Windows. Linux compilation does not run the
storage host's `_windows_test.go` files; its no-test-files result is not SCM proof.

The upstream race detector exposed an unsynchronized counter in the retained-
removal timer test's fake child. `upstream-test-race.patch` makes that counter
atomic and changes only two `_test.go` files. Its digest is recorded separately
from the production overlay; preparation refuses any other target filenames.
No hb15 production source or component identity is changed by this test fix.
The affected test additionally runs 50 times under the race detector.
Its expiry observer uses file metadata rather than repeatedly opening the receipt:
on Windows the polling reader otherwise denies deletion and causes the failure
it observes. The one-second deadline, abort count, receipt absence and preserved
Library assertions remain in place. This does not qualify production recovery
from unrelated processes holding conflicting file handles.

Evidence is per-run: source inventory, build log, image identity, combined stage
log and final result. No public release or VM storage mutation is part of this
runner. New VM large-data qualification is deferred; Windows-only smoke and
candidate-bound acceptance gaps remain separate.

The complete lane passed on 2026-09-20; evidence is
`output/docker-issue46-d949baba07f241259b850a42df66cb01` (27 stages).
It reports 207 Vitest, 323 Node, 46 Python and 113 top-level Go tests passed,
plus two pure PowerShell scripts and 50 repetitions of the repaired race test.
Explicit skips: 3 Vitest, 90 Node, 10 Go cases, and one Windows-only PowerShell
suite. Windows build-tagged Go files are additionally inventoried as unexecuted.
See `docs/validation/issue-46-cache-timeout.md` for the exact boundary.

## Original focused contract lane

On this Windows host, Docker Engine is installed in the existing
`Ubuntu-24.04` WSL distribution. From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/docker/run-wsl.ps1 -Suite contract
```

The runner starts the test-only engine and saves build/test logs, image identity,
disk usage and an explicit result under `output/docker-issue46-<id>`. Windows
PowerShell 5.1 and PowerShell 7 were exercised. No Docker group membership or
TCP daemon endpoint was added. Automatic engine startup is disabled. To stop it
after testing, once no other container jobs are using this engine:

```powershell
wsl -d Ubuntu-24.04 -u root --exec systemctl stop docker.service docker.socket containerd.service
```

On another host with a running **Linux** Docker engine:

```powershell
docker build -f tests/docker/Dockerfile -t honeybee-issue46-contract:hb15 .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 --pids-limit 128 honeybee-issue46-contract:hb15
```

The build pins the Node base image digest, repository lockfile and pnpm 11.18.0. Install scripts are
disabled; only root test tooling and Core are selected. A Dockerfile-specific
context allowlist excludes `output`, VM disks, guest evidence, local dependency
trees and credentials. Runtime has no host bind mounts, Docker socket, network
or privileges. Temporary test files disappear with `--rm`; the image and build
cache remain. Do not use global `docker system prune` to clean this project.

The focused contract suites cover 23 heartbeat/commit tests and 18 tool-pair tests.
They mock subprocesses: progressing commits beyond 600 seconds (90 simulated
minutes), stalled work despite a live service, transport/session changes,
read-only reconciliation, capability checks, configuration validation and pinned
tool dispatch. No real 3 GiB fixture is created.

This does **not** test Windows SCM, named-pipe authentication, actual NTFS/VHDX
operations, native Go worker progress, crash recovery, Electron or native cache
publication. Keep those gates on Windows. Passing this image is not a native
qualification pass or grounds to delete the last recoverable QA disk chain.

## Validation status

On 2026-09-19 both suites passed on Windows and in the Linux container: 41 tests,
zero skips. Docker Engine Community 29.8.1 and Buildx 0.37.1 were installed from
the [official Docker Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/).
No Docker Desktop installation or additional WSL distribution was needed.
The first build transferred only 387.74 kB of source context. The resulting
image is approximately 747 MB; stopped containers and Docker volumes are zero.
Image and build-cache sizes share layers and should not simply be added.

Successful runner evidence includes
`output/docker-issue46-e3162c4840644abdab13166c1bf31f66` (final PowerShell 5.1),
`output/docker-issue46-cd7789553522480985756a3fc8119fad` (PowerShell 5.1) and
`output/docker-issue46-bb0508f0b1594fbda68dea194d5094a1` (PowerShell 7).

Docker Desktop on Windows itself uses a virtualization backend and consumes
disk space. Configure its storage budget before moving tests; containers do
not automatically reclaim the existing Hyper-V QA disk chain.

## QA storage retirement

The user subsequently approved exporting evidence and retiring the QA VM.
Verified evidence is kept outside the disk chain at
`output/issue46-vm-retirement-20260919`: 205,065 latest-guest files and 7,433
older-guest files, plus link/reparse records and per-file SHA-256 manifests.
All four dedicated QA disk files and the VM registration were removed after
verification; approximately 106.6 GiB of logical disk files were deleted.
Consult that directory's README and retirement receipts for restore mappings.
Native hb15 VM qualification remains
unperformed, not waived or passed by these portable tests.

Pre-retirement inventory under `output/acceptance-completion-20260916`:

| File                               |  Logical bytes | Retention                       |
| ---------------------------------- | -------------: | ------------------------------- |
| `HyperV/fresh-beta35.vhdx`         | 37,649,121,280 | Removed after evidence export   |
| `HyperV/acceptance.vhdx`           | 16,239,296,512 | Removed after evidence export   |
| `SharedParents/shared-parent.vhdx` |  5,012,193,280 | Removed after dependency checks |
| `SharedParents/system.vhdx`        | 54,865,690,624 | Removed after dependency checks |

Sizes above are historical file lengths, not current usage or a promise of
reclaimable space. The latest leaf grew before shutdown; retirement receipts
record its final size. Future cleanup must likewise verify all VM/checkpoint
references, parent links and evidence before deleting or compacting disks.
