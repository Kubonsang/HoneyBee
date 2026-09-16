# ADR-040: Fresh service elevation in setup preview

## Status

Implemented in source and repackaged preview. Production distribution still requires
signing and clean-VM UAC/service qualification. This change does not implement an
existing-service migration or general updater.

## Execution boundary

Interactive NSIS setup remains `RequestExecutionLevel user`. After publishing and
verifying app files it requests fresh service installation only when health fails
and neither service nor receipt is reported. Silent `/S` setup never requests UAC.
An existing service or receipt blocks automatic installation/replacement; a healthy
compatible service is reused.

The installed, hash-checked host implements `install-elevated`. It accepts only a
workspace root and component version, captures the initiating process SID, queries
SCM using query-only access, and refuses existing/unknown service state before UAC.
It invokes its own fixed executable using ShellExecuteExW `runas`, with an explicit
argument vector equivalent to:

```text
install --fresh-only --workspace-root <installation>/Workspaces --user-sid <original-SID> --component-version <approved-version>
```

The privileged child repeats admission under the installer mutex. Caller-controlled
SID overrides and `--replace` are not accepted by the unelevated bridge. The original
SID survives an alternate administrator credential prompt. Desktop, Node setup and
health validation remain in the original user's process context.

The bridge uses COM initialization on a pinned OS thread, retains the child process
handle, waits for exit and closes it. It does not return on a timer while a privileged
operation might still commit. Cancellation has a distinct host error/exit code 24;
other child failures are reported as failure, not successful installation. The
[Microsoft ShellExecute reference](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellexecuteinfow)
explains the process-handle and synchronous activation flags used here.

## Health and recovery evidence

Before requesting elevation, setup syncs a per-attempt journal record. After child
completion it records that fact, then repeats the existing storage compatibility
and recovery checks in the original user context. Service-start readiness may take
up to 15 seconds to converge. Successful child exit alone does not mark setup ready.
Cancellation/failure keeps the published application and diagnostic evidence; no
service, Workspace, registry or app files are removed as compensation.

Rerunning the same interactive Setup can retry service-only work when its entire
installed inventory exactly matches the payload and its prepared/published records
are valid. It never overwrites app files during that retry. Different/corrupt or
partially published installations remain blocked. A service or receipt left by an
interrupted privileged operation also remains blocked for diagnosis; automatic
reconciliation of that case is still pending. Silent reinstall retains its refusal
behavior. A changed release requires the future updater, not this retry mechanism.

## Packaging

The host was rebuilt against the same pinned upstream commit and hb12 overlay.
Client bytes and the storage protocol version are unchanged; host byte length and
SHA-256 were updated in the Desktop compatibility inventory. Desktop main and both
packages were rebuilt to carry that identity. `build-setup.mjs` requires the host's
read-only `install-capabilities` response to advertise `freshInstallElevation: 1`,
so an old assembled host cannot produce the new interactive Setup accidentally.

Local hashes and capability checks are consistency checks, not publisher trust.
The native host is still unsigned in this development preview. An authenticated
payload handoff, signing and tamper/race qualification are required before release.

## Validation

Automated tests cover original SID/argument round-trip, rejected SID/replacement
flags, the native x64 ShellExecute structure, existing-service admission races,
healthy/silent/existing/receipt/missing states, simulated cancellation, failed
validation, query errors and journaling failure. Exact-payload service retry rejects
missing evidence and changed installed files. Dependencies are injected into the
service orchestration tests; these tests do not display UAC or change SCM.

Go tests/vet, CLI package, Desktop PTY, assembled Desktop IPC/UI and silent NSIS
installation checks are used for qualification. Actual UAC consent/cancellation,
alternate administrator credentials, clean-machine service creation, ACL receipts,
service readiness, disk-full and reboot interruption remain clean-VM gates. No
existing user service or project was changed during local validation.
