# ADR-058: Desktop update lifecycle composition

Status: internal composition implemented; production Desktop transport pending.

## Decision

`desktop-update-lifecycle.mjs` composes explicit shutdown response, exclusive
application activity, existing app-only activation with Doctor, and stable-launcher
dispatch. The caller supplies trusted source-pointer and launcher SHA-256 pins,
shutdown transport, release/service admission, Doctor authorization and restart
authorization. There are deliberately no permissive default authorizations.

The shutdown response must echo a fresh request ID and explicitly say `accepted`
or `cancelled`. Cancellation returns without activation or launch. A missing,
unrelated or timed-out response fails closed. The bounded request receives an
AbortSignal; a real transport must honor it and target the intended Desktop. An
accepted response does not prove shutdown: exclusive activity must subsequently
drain participating clients. The source pointer is checked again under that gate.

`updateAndRestartWithDoctor` calls the existing publication/Doctor/activation path,
retaining its release admission, component validation and durable activation
journal. Only terminal `Committed` or validated `RolledBack` results may request
restart. Exceptions requiring recovery do not launch anything. Exclusive activity
is released before launch so the new Desktop can obtain shared activity.

Restart authorization, a final pointer comparison and launcher digest validation
precede dispatch of the fixed `HoneyBeeLauncher.exe`, with no shell or arbitrary
command-line arguments. A restart failure preserves the terminal activation result
and returns `restart: Failed`; it never rolls back a committed update merely
because launch failed. `Dispatched` means the launcher invocation succeeded, not
that Desktop became ready: the GUI launcher intentionally detaches.

## Verification

On 2026-09-13, nine coordinator tests, eight native activity tests and sixteen
published-update tests passed (33 total). They cover cancellation, timeout,
unrelated responses, accepted response with a still-running client, commit,
validated rollback, recovery-required failure, launch failure, denied restart,
changed pointer and launcher tampering. Two integration cases use real publication,
pointer replacement, rollback and Doctor adapters with fixture Doctor output and
explicit shutdown/dispatch doubles. Shared admission at dispatch proves exclusive
activity was released. These tests are included in `test:update`.

## Remaining integration and limitations

This is an internal composition module, not a public Update & Restart command.
The actual Desktop shutdown transport and UI are not connected in this change.
They must bind a response to the intended installation/session and user consent,
honor cancellation, and prohibit unauthenticated shutdown requests. A transport
response or activity marker is not release trust or proof that legacy clients and
external tools are idle. Existing release admission remains mandatory.

Production shutdown acknowledgment, post-launch Desktop readiness and packaged
end-to-end qualification remain next. No real service, project, installed version
or VM was changed by this qualification. The ADR-057 packaged lifecycle smoke is
separate evidence and does not qualify this complete update sequence.

The existing activation journal remains the durable recovery authority. Shutdown
and launch attempts are not a second durable transaction; a crash after commit
can require manually launching the stable launcher. There is no automatic restart
replay after reboot in this module. Concurrent activity after exclusive release
can prevent Desktop admission; the final pointer check does not eliminate that
race. Further restart acknowledgment must report the actual selected version and
ready state rather than infer readiness from launcher exit.
