# Packaged Doctor through Windows Job Object: host qualification

## Scope and result (2026-09-11)

Executed the real assembled beta.11 CLI with its private Node 24.13.1 through the
ADR-053 native Job Object helper against the existing host Storage Service. This
was a read-only diagnostic run, not a fresh install, successful update, guest VM
qualification, Desktop launch or service migration test.

The complete published payload was verified against the existing pinned package
plan before execution, including inside the explicit authorization callback.
The plan digest was
`85b4b1ff333ef324c93a957b72057b48c11acf948ae09dfd497774e37f2eb98b`.
The version directory was the isolated published copy under
`output/update-prepare-smoke/case-rvGNQM/HoneyBee 설치/versions/0.1.0-beta.11`.
This plan's original source observations were synthetic. Its file pins establish
which local build was tested, not a production release signature or live-source
admission. No activation was attempted.

Final evidence is in `output/doctor-qualification/host-H3EciF/result.json` and
`process-error.json`; the latter retains the raw Doctor stdout and process error.
The local reproducibility driver is `output/doctor-qualification-run.mjs`.
Output artifacts are local qualification evidence, not committed release assets.

Doctor returned **23 passes, zero warnings, four failures**, and exit status 1.
The new runner returned `ready: false` and retained the structured report:

- Two `project.storage-tools` failures: registered tools were missing or differed
  from the tested package.
- Two `workspace.repair-required` failures: existing workspaces needed attention.

Windows, private Node, Git, registry readability, bundled package integrity,
service, receipt, component identifier, workspace-root access and storage status
passed. Doctor observed two registered projects and five storage parents. These
are existing user resources and were not recreated, repaired or removed.

Pre/post SHA-256 snapshots matched for the tested root's pointer and sentinel,
the user's workspace registry, service receipt, broker configuration and broker
executable. This demonstrates preservation of those observed files; it does not
claim that every workspace file or service log was snapshotted. SCM was observed
as Running, automatic startup and LocalSystem before the run.

## Defect found and fixed

The helper originally discarded buffered stdout/stderr when Doctor returned a
nonzero exit. The first attempt, `output/doctor-qualification/host-iwWpEv`, therefore
reported only exit status 1. Current CLI explicitly sets exit code 1 when Doctor
is not ready, even though it writes an `ok: true` inspection report.

The helper now forwards bounded stdout/stderr before returning the process error.
The JavaScript runner optionally decodes a valid report from failure stdout for
diagnostics while keeping `ready: false`. Even a report claiming readiness cannot
turn a nonzero process exit into successful update health. Timeout/overflow
termination still need not preserve partial output.

Two regression tests cover native nonzero-output preservation and refusal to
promote a failed process with an otherwise healthy report. The 16 health tests and
six containment tests passed after the change. Go tests and vet passed as well.

## Compatibility finding and remaining gates

The host receipt's broker digest was
`0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3`,
while this package's control digest is
`18fc8e906ecd7a86885e3097915a276a2f781cfa33e32f529349ff2d3cfc5385`.
Both advertise `0.0.0+cfa606fd4143.hb12`. The packaged Doctor passed its component
identifier and receipt checks despite that difference. Doctor therefore cannot
replace the stricter source service identity/evidence gate from ADR-046/047.
No matching-version assertion should be treated as matching binary identity.

The compatible guest health run subsequently passed as recorded below. This does
not resolve the host's existing project/workspace failures or replace the source
identity gate. No host projects or services were repaired to obtain a passing result.

## Prepared guest follow-up

The `scripts/qualification/guest-doctor-job.ps1` entry point checks the exact guest
computer name, original installing SID and an unelevated token before running
the pinned installed private Node. Its companion module validates the original
Setup inventory, native helper hash, service receipt SID and actual broker hash.
It then executes the same Job Object health runner and records raw diagnostics,
structured health and pre/post persistent-file hashes in a unique Evidence folder.
It does not install, activate, repair or migrate anything.

A self-contained development bundle was prepared at
`output/vm-qualification/doctor-job-20260911-014027`. Its inventory comes from
`output/setup/build-C1komL/bundle`, the Setup previously used by the guest. Its
configuration targets `DESKTOP-9LT0JVV` and the original guest user SID. The bundle
includes the required update modules, built Core modules and native helper; import
resolution, PowerShell parsing, lint and formatting were checked. Running the
guest module on the host correctly refused the computer mismatch before execution.

Hyper-V queries were denied to the ordinary host token. After a host reboot, the
user manually ran the transfer script in administrator PowerShell. A Windows
PowerShell 5.1 encoding error was fixed by writing the script with a UTF-8 BOM and
checking it with the actual 5.1 parser. An initial file transfer failed with
`0x800710DF` while guest file-copy support was not ready. The retry script now
prints progress, writes UTF-8 results and retries that readiness error for a bounded
period. It may start the existing stopped/saved VM, but never resets it, restores
a checkpoint or changes guest integration settings.

## Guest result supplied by the user

On 2026-09-11 the user supplied a successful transfer result for the existing
`HoneyBee-Setup-QA-20260910` VM: 80 files delivered to
`C:\HoneyBeeQA\doctor-job-20260911-134323` (attempt `20260911-134323`).
The user then ran `HoneyBee-Doctor-QA.cmd` as instructed and supplied:

```json
{
  "evidence": "C:\\HoneyBeeQA\\doctor-job-20260911-134323\\Evidence\\guest-wwiEpu",
  "ready": true,
  "summary": { "pass": 12, "warning": 1, "fail": 0 },
  "preserved": true
}
```

The entry point also printed `Doctor Job Object qualification PASSED`. This is a
successful real packaged Doctor/Job Object/service health run based on user-provided
guest output. The guards enforce the original user, unelevated execution, expected
installed payload and broker identity before the run. `preserved: true` reports
matching pre/post hashes for the pointer, registry, receipt, broker configuration
and executable. The supplied summary does not identify the warning; its exact
check must be confirmed from the full guest report rather than inferred.

The guest evidence directory has not yet been exported or independently inspected
on the host. This pass does not qualify an actual version switch, rollback,
service migration, reboot interruption or Desktop restart. The next integration
gate is explicit source/target health wiring into the app-only activation path,
with release admission and quiescence still required before production use.
