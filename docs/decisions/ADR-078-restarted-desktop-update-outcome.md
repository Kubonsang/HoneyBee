# ADR-078: Update outcome in restarted Desktop

Date: 2026-09-14

Status: Read-only outcome restoration implemented. No additional VM acceptance gate.

Activation dispatch atomically replaces `update/latest-activation.json` with a small
job-name/request-hash reference before starting the worker. This avoids scanning job
timestamps or guessing which update caused the restart. Interrupted marker writes
leave the previous marker and an unreferenced partial file; evidence is preserved.
The marker is display metadata, never recovery or execution authority.

On startup, managed Desktop reads this reference and its bounded request/result files.
Committed and rolled-back results additionally require the existing activation journal
validator, matching source pointer hash, a consistent terminal history, and an exact
match between the current pointer and the journal's selected pointer. An old result
for a different active installation cannot be shown as successful. Restart failure
is displayed as failure without changing a committed pointer.

Missing, malformed, conflicting or incomplete evidence produces Unresolved rather
than success. A failed pre-activation job or cancelled shutdown requires the original
source pointer still to match. No job, executable, Doctor, migration or rollback is
started by the reader. It cannot restore an apply ticket or authorize a retry.

The renderer checks status on mount and opens the result panel for a recorded outcome.
Unresolved results are reread at one-second intervals for at most 30 polls, allowing
the worker to record completion after the new renderer becomes ready. An explicit
new update check ends restoration; a late read cannot overwrite that operation.
Closing or restarting Desktop never replays the referenced job. The latest outcome
can be displayed again on later launches; persisted acknowledgement is not part of
this change.

If the worker dies after switching or startup recovery runs without producing a
worker completion result, this reader remains Unresolved. It does not infer a
successful recovery by searching unrelated journals. The bootstrapper's recovery
behavior and preserved evidence remain unchanged.

Validation: 11 outcome tests and 18 Desktop controller tests passed, including
terminal/current binding, altered requests/results, missing/conflicting journals,
late results, restart failure and restoration without activation. Main/preload/
renderer type checks, ESLint, three Vite builds and real Electron IPC/UI smoke passed.
Outcome tests use synthetic journals; fixture smoke does not claim a real signed
update/reboot qualification. The previously fixed integrated qualification remains
the final check of the complete installation/update flow.
