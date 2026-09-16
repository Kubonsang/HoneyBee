# ADR-073: Authenticated inactive update preparation

Date: 2026-09-13

Status: Backend preparation composition passed local tests; independent activation
worker and Desktop handoff remain unimplemented.

This continues the existing acceptance scope. No additional VM test is requested.

## Durable trust evidence

Authenticated staging now exclusively writes and syncs `release.sig.json` before
returning success. The verifier returns its own copy of signature bytes, just as
it already snapshots manifest bytes. Failure to preserve the proof prevents the
Desktop download operation from reporting completion. The legacy internal stage
primitive remains unchanged; its Verified marker alone is not publisher authority.

`authenticateStagedRelease` accepts only a plain `update/stage-*` directory under
the installation, reads bounded manifest/signature files, authenticates them against
the caller's trusted keys and requires the originally selected manifest digest.
A missing, replaced or differently signed proof does not become trusted because a
previous process reported a signer ID.

## Preparation

`prepareAuthenticatedUpdate` composes existing production primitives:

1. Authenticate the saved offer and reject service-replacement releases, which
   require the still-pending service coordinator.
2. Run the real managed source/service observation by default; require an app-only
   candidate. No QA observation is supplied by the production entry point.
3. Create the pinned plan through the existing ZIP extraction/inventory checks.
4. Publish the verified target under `versions` while keeping it inactive.
5. Recheck admission and write/sync `authenticated-preparation.json` alongside the
   plan, binding the release/signer, source pointer, plan hash and publication path.

Every observation requested by plan/publication also reauthenticates the stage.
The result is `ReadyForActivation` with `activationAllowed: false`: it is preparation
evidence, never permission to skip activation, Doctor, lifecycle or recovery gates.
The method does not shut down Desktop, mutate `current.json`, invoke UAC, replace
the service or execute target application code. An error preserves the existing
plan/publication evidence for diagnosis.

## Checks and limitations

- Eight preparation tests passed, including real native ZIP packing/extraction and
  inactive publication with a test source observer. The observer simulates a stable
  compatible service; this is not an actual service migration/health qualification.
- Signature/manifest/pin/path failures, blocked service admission, signed migration
  requests and signature mutation during preflight are refused. Tests verify the
  original pointer, version sentinel and user-state sentinel remain unchanged.
- Native tool invocation was denied in the sandbox. The suite passed outside it
  using isolated workspace output; no installed service or user project was changed.
- Fifty-five existing authentication/discovery/staging tests passed, including
  persisted signature bytes. ESLint/format checks passed.
- The new native preparation suite is in `test:update-trust`, after `test:update`
  has built its native/core prerequisites in the full test pipeline.

The Desktop is not wired directly to this module: its native helper/core paths
must be supplied by an independently packaged trusted updater runtime. The current
recovery runtime still approves only its initial source. Packaging a worker and
extending consecutive-source recovery must precede enabling Update & Restart.
