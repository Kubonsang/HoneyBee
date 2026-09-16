# ADR-055: Cooperative application activity gate

## Scope

The native update-package helper now provides `activity DIRECTORY MODE TIMEOUT_MS`,
with an internal JavaScript `withApplicationActivity` wrapper. This is the
cross-process foundation for waiting on Desktop/CLI activity before activation.
There are no Desktop, CLI, Launcher or production updater callers yet. Existing
apps do not participate automatically. No user process is terminated by this gate.

Desktop currently has a `before-quit` terminal confirmation through
`ptySessions.requestQuit`; cancelling it must remain effective in a future update
shutdown flow. This gate neither invokes nor bypasses that confirmation. CLI
commands currently dispatch without an installation-wide activity lease. Closing
Desktop alone therefore does not establish application quiescence.

## Native protocol

Two files under the installation's `update` directory are ownership handles, not
durable state markers:

- `application-admission.lock` serializes entry against updater draining.
- `application-activity.lock` tracks shared activity or exclusive updater ownership.

A client acquires a shared admission handle, acquires a shared activity handle,
then releases admission while retaining activity. Multiple clients can coexist.
An updater acquires exclusive admission first, then waits for exclusive activity.
Once draining begins, new clients refuse admission. Existing clients continue until
they release their activity handles. A competing updater refuses admission too.
Windows sharing modes enforce both locks; file existence and PID reuse do not
determine ownership. Redirected directories and reparse-point lock files refuse.

Only activity sharing violations are retried, every 25 ms, up to a requested
1–120,000 ms deadline. The native helper prints `DRAINING` after closing admission
and `HELD` only after acquiring activity. A parent-owned stdin pipe defines lifetime
even during draining. EOF, timeout or process death closes held handles. Lock files
remain reusable, with no stale-file deletion. Non-Windows platforms refuse.

The JavaScript wrapper runs the helper hidden, invokes work only after `HELD`, and
releases ownership in `finally`. It exposes `assertHeld` and an abort signal when
the helper exits. Callers must observe lost ownership and stop new protected work;
the wrapper cannot forcibly unwind an arbitrary callback or in-flight service
operation. A helper failure is not proof that its client finished safely.

## Integration requirements

Production wiring must require participation by all relevant Desktop/CLI entry
points and keep leases through their protected activity. Old/portable applications,
external tools, detached descendants and another installation's service operations
are not accounted for by this per-installation gate. An exclusive handle is not
sufficient to infer that those processes have stopped.

The intended lock order is activity ownership before the existing installation
update lock. A client must not retain shared activity while waiting for an updater
that needs exclusive activity. Shutdown request/acknowledgement, terminal consent,
in-flight operation draining and handling of lost lease ownership must be designed
at the app entry points before this becomes an activation admission condition.
Doctor execution during exclusive ownership will need an explicit authorized
internal path so it does not deadlock on ordinary shared client admission.

App restart also remains separate: select the committed/restored version via the
stable Launcher only after releasing exclusive activity. Signing, helper assembly
and capability negotiation must prevent an unparticipating old client from being
treated as safe. No service migration or reboot recovery is authorized by this gate.

## Validation

Eight activity tests exercise concurrent shared clients, refusal of new clients
during drain, competing updaters, successful drain after release, timeout without
killing clients, client termination, updater termination while waiting/held,
parent-pipe disconnect, callback failure, independent installations and redirected
paths. The combined activity, transaction and Doctor containment suites passed
22 tests. Go tests, vet, lint and formatting passed. Test processes and files were
isolated under `output`; real Desktop/CLI shutdown and restart are not yet qualified.
