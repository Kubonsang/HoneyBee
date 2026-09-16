# ADR-053: Windows Doctor process containment

Real packaged host qualification and the subsequent nonzero-output preservation
fix are recorded in [the qualification report](../validation/packaged-doctor-job-qualification.md).

## Decision

The internal Doctor transport now runs through the native update-package helper's
`doctor NODE CLI DIRECTORY TIMEOUT_MS` command. It uses fixed `doctor --json`
arguments, absolute paths and the sanitized environment from ADR-052. Execution
authorization and payload verification still belong to `checkVersionHealth` and
its caller; the native transport alone is not a trust boundary.

Before spawning Doctor, the Windows x64 helper creates an unnamed, noninheritable
Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assigns itself to it.
Doctor and its ordinary child processes therefore inherit job membership from
creation, avoiding a start-then-assign race. No breakaway flags are enabled.
Job setup failure refuses execution; there is no uncontained fallback. Nested-job
restrictions from a containing host can likewise refuse execution.

The helper keeps the sole job handle until process exit. Closing it explicitly
would also terminate the helper itself. Exit, forced termination or crash closes
the handle and terminates remaining job members. A parent-owned stdin pipe acts
as a lifetime lease: EOF terminates the helper. Doctor receives no inherited lease
pipe or job handle. The helper launches Doctor hidden with no shell or elevation.

These semantics follow Microsoft's [Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
The native layout follows [JOBOBJECT_EXTENDED_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).
The helper explicitly refuses non-x64 Windows and non-Windows execution.

## Bounds and outcomes

The native deadline is 1–120,000 ms (60 seconds by default). Exceeding it exits
the helper and closes the job. Each output stream has a 1 MiB buffer whose writer
terminates the helper on overflow. A 500 ms Go `WaitDelay` bounds waiting on
descendant-held output pipes after the direct child exits. A successful direct
child may finish normally; any remaining descendants still terminate on helper
exit. Pipe-wait errors and nonzero child exits fail health.

The JavaScript transport retains an outer deadline five seconds beyond the native
deadline and output bounds. Killing the helper on outer failure also closes its
job. Error text is diagnostic output; Doctor JSON validation remains in ADR-052.
The deadline does not cover caller authorization and file hashing.

## Qualification

Six real Windows process-tree tests check eventual absence of the exact fixture
child and grandchild PIDs after normal exit, timeout, helper termination, calling
Node process termination, inherited output-pipe use and output overflow. They
use isolated directories and synthetic Node scripts, not the real service.

The full update suite passed 97 tests before the final overflow-tree test was
added; the final six-test containment suite then passed. Go tests, vet, ESLint and
format checks passed. Sandbox restrictions required running native filesystem and
process qualification outside the sandbox; no real installation or service was
modified.

This contains ordinary descendants, not execution brokered through SCM, WMI or
another already-running process. It is not a security sandbox for untrusted code.
It does not terminate or reinstall the existing Storage Service. Real packaged
Doctor/service behavior, managed-host job restrictions and reboot qualification
remain to be tested before automatic updater integration. The helper is still a
development build artifact; production assembly, signing and helper identity
pinning remain required distribution work.
