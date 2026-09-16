# Remaining interruption/rollback implementation completed

The implementation left after the successful-sequence runner is now connected:
seven process interruptions, two guest Windows restarts, one forced VM power-off,
and the existing app/service health-failure rollback cases. No acceptance gate was
added. This is implementation completion, **not a claim that the VM cases passed**.

## Delivered code

- `interruption-matrix.mjs` defines the fixed cases, persists intent before each
  mutation, preserves completed results and validates recovery after a new boot.
  An explicit `--retry-case` creates a new attempt for only the affected case after
  source health and preservation checks; old evidence is never deleted.
- `windows-matrix.mjs` stages/authenticates the actual packages, creates an actual
  activation job, runs the real update coordinator, and invokes the installed
  Launcher for recovery. It checks exact original pointer bytes and uses the
  integrated runner's actual Doctor/service/hash and source-preservation checks.
- `fault-worker.mjs` holds app checkpoints after preparation, pointer selection,
  and successful validation before commit. Its injected validation exception
  exercises the ordinary rollback path. Normal worker execution has no switch
  that enables these hooks.
- The storage companion's `honeybee_qualification` build tag adds protected
  checkpoints at `BackupVerified`, `Stopped`, `Replaced`, and `ReadyForAppCommit`.
  The QA controller can terminate only the recorded update owner/session after
  checking process creation time and executable identity using held handles.
  Protected records bind the migration, manifest, nonce and owner. Commands and
  checkpoint behavior are absent from the normal production build.
- The guest controller stays unelevated; the QA fault observer alone requests
  UAC in addition to the product's normal service-operation elevation. Requests,
  reached evidence and expired holds cannot silently become accepted coverage.
- On the two restart cases, the guest wrapper requests a Windows restart after
  flushing pending evidence. The operator signs in and reruns the same command;
  it validates recovery instead of replaying the interrupted mutation.
- `host-poweroff.ps1` performs the one explicit forced-power-off case against the
  pinned QA VM ID, retains a nonce-bound host witness, starts the VM, and copies
  the witness to that case. It is only executed by the operator at the reported
  checkpoint. A late restart/power-off is not accepted as checkpoint coverage.

These scripts do not restore VM checkpoints, uninstall existing services, reset
projects, rewrite app pointers directly, or force-detach storage volumes.

## Built artifacts

New bundle: `output/integrated-qa/integrated-MtgfoJ`.
Metadata: `output/current-instrumented-qa.json`.
Build logs and signed input binding:
`output/instrumented-qa-builds/build-DHTIC9`.

The bundle contains 117 files, approximately 1.37 GB. Its QA baseline Setup is
`output/setup/build-UtE8jh/HoneyBeeSetup-qualification-baseline.exe`.
The instrumented source service SHA-256 is
`fb4ceb70b47f42b81fedcd12c3ceb81a3a0af4bbcf38bc3584e83582328e1fb0`.
The production target service remains
`90deb68a07c78376c104f6609795c6ba15fbd8cba40b95bcdb410a95ad9d2578`.

The source is explicitly an **instrumented QA baseline**, not a historical
release. This exercises real replacement/recovery mechanics without claiming
automatic legacy hb12 or storage-schema migration. The beta.13/beta.14 packages
are still QA-only and unpublished. The production beta.12 Setup, archive and
release manifest were not replaced.

The metadata field `interruptionMatrixImplemented: true` describes this completed
implementation. The existing `fullMatrixReady: false` and `publicationAllowed:
false` retain the broader final acceptance hold: the 16-gate acceptance ledger
has not been completed or promoted by building this bundle.

## Verification completed locally

- 31 related JavaScript tests passed, including real Git preservation, exact
  rollback pointer restoration, restart resume without replay, affected-case
  retry, candidate binding, and refusal of an expired checkpoint hold.
- Production Go tests and vet passed. QA-tag admission/process-identity tests and
  vet passed. Production explicitly rejects the QA commands.
- ESLint/Prettier passed. All five PowerShell scripts parsed successfully.
- The newly built QA companion reports `protectedCheckpoints: 1`.
- The bundled Node resolves the actual integrated/matrix module dependencies.
- Bundle copies were verified by SHA-256 and update manifests authenticated with
  the configured Ed25519 key. No private key was exported.

## What remains

Actual VM execution and the existing final acceptance/release work remain. No
service, VM, installed application or project was modified during implementation.
The last attempted Hyper-V inspection lacked host administration rights; that is
an execution constraint, not unfinished implementation of the matrix.

Use the one integrated bundle for the agreed final session. Preserve earlier
unaffected evidence; rerun only affected cases. Windows Authenticode remains
deferred by the user's decision. GitHub publication has not occurred.
