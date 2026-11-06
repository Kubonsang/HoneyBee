# ADR-052: Explicit-version Doctor health runner

## Status and execution boundary

`scripts/update/version-health.mjs` adds an internal `checkVersionHealth` runner.
It executes the selected version's private `runtime/node.exe` with absolute
`cli/dist/cli.js doctor --scope installation --json` arguments, without a shell or stable shim lookup.
The working directory is that version's directory. It does not select a version,
write an activation journal, run Repair or request elevation.

Execution requires an explicit authorization callback returning exactly `true`.
The caller must authenticate the payload and validate its complete inventory,
service policy and application quiescence. This callback is separate from user UAC;
it represents a required internal trust decision. There is no permissive production
default. The runner is not yet wired into Desktop or the activation adapter.

The caller supplies the version and launch-manifest SHA-256. The shared
`verifyAppVersion` helper verifies the explicit directory, launch metadata,
Desktop executable, private Node, CLI entry and installation metadata before
execution and after a successful process result. It does not consult `current.json`.
These launch-critical hashes do not replace whole-payload verification or signing.

## Process and report policy

The process has a 60-second default timeout, configurable from 1 to 120,000 ms,
and a 1 MiB stdout/stderr buffer limit. It runs hidden and inherits the initiating
user's environment, excluding case-insensitive Node injection/lookup variables
`NODE_OPTIONS`, `NODE_PATH`, `ELECTRON_RUN_AS_NODE` and the explicit
`HONEYBEE_WORKSPACE_STORAGE` override. Normal PATH and user profile variables remain
available for Git and the existing per-user registry/service checks.

A nonzero exit, timeout, output overflow, malformed JSON, unexpected stderr or
post-run launch-file mutation produces `ready: false` with a failure description.
Missing/refused authorization and failed pre-execution identity verification throw
before process launch. Consumers must treat both an exception and `ready: false`
as failed health. Raw error descriptions are diagnostic data and may contain paths
or captured process output; they are not a user-facing update message.

Exit code zero and `ok: true` are insufficient: current CLI Doctor reports a
successfully executed inspection independently of its `ready` result. The decoder
requires schema 1, boolean readiness, valid checks and exact summary counts, and
requires readiness to agree with the absence of failed checks. Required checks
cover Windows, Node, Git, registry readability, storage executables, package
integrity, service, receipt, compatibility, workspace root, status and project
registration. Required component checks cannot be duplicated or omitted.

All required component checks must pass. The no-project registration warning is
allowed. Installation-scoped Doctor checks the real registry, package, installed
owner, service, component version and storage status, without inspecting individual
project bindings or Workspace states. Its JSON declares `scope: "installation"`;
unknown scopes or unexpected scoped checks fail validation. Default
`honeybee doctor --json` still performs the full inspection and reports damaged
projects and Workspaces as failures. Installation readiness does not authorize
those Workspaces for use or perform repair/cleanup. Failed target health is saved
separately before rollback and never becomes commit evidence.

This scope prevents old project tool paths and pre-existing repair-required
Workspaces from rolling back an otherwise healthy application/service update.
Repeated per-project check codes remain allowed in unscoped reports.
Future Doctor schemas or renamed required checks need an explicit compatibility
update rather than silently passing an incomplete report.

## Validation and remaining qualification

Fourteen tests cover valid warnings, missing/duplicate/inconsistent reports,
component failures, fixed candidate paths, authorization, pre/post-run tampering,
malformed output and stderr. Real Node child processes test nonzero exit, timeout,
output overflow, fixed arguments and environment sanitization. The complete update
suite passes 92 tests; lint and formatting checks pass.

These tests use synthetic installation files and Doctor reports. They do not run
the packaged CLI against a real service or launch Desktop. A passing Doctor result
does not establish that the Electron UI launches. Existing installations and the
QA VM were not changed.

Node's child-process timeout terminates the direct child, not a guaranteed Windows
process tree. Doctor can spawn Git and storage tools, so Job Object containment
and orphan/pipe cleanup qualification remain necessary before production wiring.
The timeout does not bound authorization or pre/post hashing time. The existing
Doctor is reused as an observational check; process containment is not a sandbox
against an untrusted executable, which is why authorization must precede launch.

Next work is Windows process-tree containment, followed by packaged Doctor/service
qualification and explicit mapping from activation phases to pinned source/target
versions. Admission, service migration and automatic startup recovery remain
separate requirements.
