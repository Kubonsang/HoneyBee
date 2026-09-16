# ADR-049: Internal app-pointer commit and conservative rollback primitive

## Status and call boundary

Implemented in `scripts/update/app-activation.mjs` and exercised only with synthetic
installations under `output/activation-tests`. Unlike earlier validation helpers,
this primitive actually changes a pointer in the root passed by its caller. There
is deliberately no CLI, Desktop, Setup or production updater caller in this step.
Existing user/VM installations and approved packages were not changed.

Both activation and recovery require explicit admission and health callbacks. There
is no permissive default. Before production wiring, admission must authenticate the
release, validate the complete prepared and published inventory, bind the approved
plan, quiesce application/workspace operations and recheck service/registry identity
under the held installation lock. The callback API is an internal composition
boundary, not proof that these gates are implemented or a replacement for them.
Tests supply synthetic admission/health behavior and execute no target programs.

## Scope

The primitive operates on two already-published immutable version directories.
It does not copy prepared payloads into live versions, install a service, change
user data, migrate data schemas, launch programs or remove an older version.
Source and target must declare exactly the same Storage component identifier;
service migration is refused. Same identifier is only this primitive's local
constraint; the full source/target evidence policy remains the caller's gate.

It checks the source pointer's externally supplied digest, schema and positive
safe-integer generation. The target must be newer, uses generation + 1, and must
match the caller's launch-manifest pin. Both launch manifests have the managed
Launcher schema; Desktop, private Node, CLI entry and installation metadata hashes
are checked. Version paths must not redirect. Installation metadata identities and
Storage identifiers are checked. Whole-package verification belongs to admission,
not these limited launch checks.

## Commit protocol

The existing Windows installation handle lock covers the operation. Incomplete
validation transactions or earlier nonterminal activation attempts block a new
activation. Source and target health callbacks run before intent publication.
The target health callback runs again after the pointer changes, with distinct
source-health, target-before-switch and target-after-switch phases.

The attempt stores exact source/target pointer bytes and a digest-bound intent:

```text
update/activations/activation-<unique>/
  source.json
  target.json
  intent.json
  Switching.state.json
  Switched.state.json
  Committed.state.json
```

Pointer copies, intent and state records use exclusive creation and file sync.
Switching is persisted before pointer replacement. The replacement is written and
synced to a unique file next to `current.json`, then renamed over the pointer on
the same filesystem. Exact expected pointer bytes and ownership are checked before
replacement. The old pointer is never deleted first. A failed rename leaves the
old pointer and evidence intact. Temporary files are retained after interruption.

Committed is recorded only after target post-switch health, launch-file integrity,
and current-pointer identity succeed. The generation change is therefore provisional
until the commit record exists. The root Launcher/shim binaries remain untouched.

## Rollback and recovery

A caught failure after intent attempts conservative rollback. Recovery without a
terminal outcome does the same, even if the pointer already names the target.
RollingBack is persisted before restoring the exact old pointer bytes, then
RolledBack is persisted. This restores the original generation too; generation is
an activation revision, not a globally monotonic anti-replay security counter.

Rollback requires intact source launch files and a successful source recovery-health
callback. It accepts only the exact saved source or target pointer. An unknown,
missing or externally changed pointer is never overwritten. If the source cannot
pass recovery health, evidence and both versions remain and the operation reports
recovery required. It does not guess a third version or destroy workspaces.

Recovery requires the caller's original source-pointer pin, target version and
launch-manifest pin. It verifies saved pointer hashes, generation/version progression,
state-record bindings and supported history. A terminal Committed/RolledBack attempt
is idempotently reported only while its expected pointer and launch files still
match. Terminal attempts from an older update cannot overwrite a later activation.

A malformed/torn state record or an orphan directory created before complete intent
blocks automatic recovery and needs diagnosis. State files are evidence, not signed
recovery authorization; the caller must establish admission again. This protocol
has no automatic journal deletion or abandonment of mutating attempts.

## Qualification

The full update suite passed 59 tests; the final activation checks were re-run with
all 12 activation tests passing. They cover commit and idempotent recovery, exact
byte rollback on health failure, exceptions before/after switch, absent admission,
stale source, Windows replacement failure using a read-only pointer, unknown-pointer
preservation, incompatible service versions, unhealthy rollback source, incomplete
validation blocking, and actual process termination before/after pointer replacement.
Both kill tests reacquire the Windows lock and restore the source conservatively.
Old version directories and sentinel user data remain throughout.

Lint and formatting checks pass. This is real filesystem/handle testing with dummy
executables, not evidence that a real Desktop restarted, Doctor passed, or a service
migrated. Reboot/power-loss durability, full published-inventory admission, signed
release trust, operation quiescence, source capability rollout and actual app/service
integration remain open before exposing Update & Restart.
