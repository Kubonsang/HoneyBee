# Two-version app update qualification

## Status

The real beta.12 QA candidate is built and its complete package passes staging,
preparation and inactive publication validation. The user subsequently reported
successful beta.11-to-beta.12 pointer activation, injected-failure rollback and
process-interruption recovery in separate QA guest installation roots. Full guest
evidence has not yet been exported or independently inspected on the host.
No production release or original guest installation was updated by these scenarios.

## Build provenance

`scripts/qualification/build-two-version-candidate.mjs` copies the current Core,
CLI and Desktop source into a unique `output/two-version-qa/build-*` directory.
Only that copy changes to `0.1.0-beta.12`, including package metadata, the CLI's
compiled version constant and Desktop compatibility metadata. It compiles Core
and CLI with TypeScript, builds all three Desktop Vite targets, runs the existing
CLI/Desktop packagers and assembles the existing managed installation layout.
The working repository remains beta.11. This is a QA-only build, not a released
beta.12 or a folder rename of the previous package.

Dependencies are reused through directory junctions to the existing installation;
there is no dependency install/update. In particular, workspace module resolution
can use the original built Core dependency through those links. This is not a
hermetic release build. The copied Core is compiled and used by CLI packaging.
The existing pinned Node runtime, Launcher and Storage binaries are copied; there
is no service compatibility bump. The output includes complete build logs.

The completed build is `output/two-version-qa/build-SBLJkP`. Desktop packaging
initially required network access to obtain Electron 43.4.0; that isolated packaging
step was resumed outside the network sandbox and then assembly completed.
The resulting installation is:

```text
output/two-version-qa/build-SBLJkP/output/installations/0.1.0-beta.12-gx1Xac/HoneyBee
```

`output/two-version-qa/candidate.json` records its location and QA-only status.
The installed private Node executing the candidate CLI reports `0.1.0-beta.12`.
The old guest Setup remains the pinned beta.11 artifact from the previous guest
Doctor qualification; do not replace it with this candidate to prepare the test.

## Package evidence

The existing `smoke-prepare.mjs` ran against the actual assembled candidate. Evidence
is under `output/update-prepare-smoke/case-mdzyaO/result.json`:

| Property                 | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| ZIP bytes                | 213,171,698                                                        |
| Release manifest SHA-256 | `2e652765bd7fbbce3118624912d92d7bc9f56f21dcd7e7565b15252e88f63006` |
| Launch manifest SHA-256  | `2817cbebc0247d04e1546d87fbeb492bba05af96847bd46b1006cf5dc97ee69c` |
| Plan SHA-256             | `5607e8f7067ada68d7e075525be68a1f6850e654c9ec91f51435ea9174bb3a03` |
| Result                   | Prepared and Published; activationAllowed=false                    |
| Storage component        | `0.0.0+cfa606fd4143.hb12`                                          |
| Storage client SHA-256   | `01c187941a2dc20271b7326601eb1a00e8d097b993ba16615fc27ee36caf86e3` |
| Storage control SHA-256  | `18fc8e906ecd7a86885e3097915a276a2f781cfa33e32f529349ff2d3cfc5385` |

The Storage client/control identities match the earlier approved beta.11 package.
The smoke verifies the full package and preserves its isolated pointer/sentinel;
source observations are synthetic. It does not execute the service or establish
real updater admission. Builder lint and formatting checks pass.

## Required next guest scenarios

Use a new qualification root separate from `%LOCALAPPDATA%\HoneyBee`. Copy the
verified beta.11 app files into it and stage the separately pinned beta.12 package.
Keep the original service and user registry in place and snapshot their observed
identity before and after each scenario. Do not substitute version-label equality
for the broker digest gate. Earlier packaged tooling may lack the newer service
evidence command, so any QA-only observation adapter must be documented explicitly
and must not become production admission.

1. Successful app-only activation: source Doctor, candidate Doctor before/after
   switch, exact target pointer and both version directories retained.
2. Forced target-health failure after switch: source Doctor and exact previous
   pointer restored. Inject failure in the qualification controller, not user data.
3. Kill the qualification process after pointer replacement: explicit recovery
   restores the source and validates it without relying on the current shim.
4. Refuse changed payload/service identity before switch and retain evidence.

Each scenario needs a separate disposable installation root and durable evidence.
No Setup reinstall, automatic project repair or production Update & Restart UI is
part of this preparation.

## Prepared guest runner

`scripts/qualification/guest-two-version.mjs` and its PowerShell entry point now
implement the first three scenarios above. Each uses a fresh `Cases/case-*` root
inside the delivered bundle. The installed beta.11 files are copied after verifying
the original Setup inventory; the real beta.12 ZIP goes through staging, pinned
plan creation, preparation and publication before Doctor-backed activation.
The changed-payload/service refusal scenario remains covered by component tests,
not an additional real guest scenario in this bundle.

Admission checks retain the original installed pointer, registry, receipt, broker
configuration and executable hashes. The initial guard requires the original guest
SID, an unelevated token, no registered projects/workspaces, zero parents reported
by the real source Doctor, and at least 8 GiB free on C:. Health authorization
checks the full selected source/target payload and unchanged observed user/service
state. The baseline-based source observer is explicitly QA-only: it is not the
production service-evidence protocol, source preflight or application-quiescence
implementation. The copied test versions are not launched as Desktop applications.

The rollback scenario runs the real target Doctor and then injects a controller
failure after pointer switching. The crash scenario starts the activation in a
child process, waits for its post-switch checkpoint, kills it and uses the pinned
journal for explicit recovery. Evidence and both versions are retained. The
original installed pointer is never an activation destination. There is no cleanup
or automatic repair step.

The transfer bundle is
`output/vm-qualification/two-version-20260911-230149`. It includes the actual ZIP,
manifest, source inventory, helper and required JavaScript modules. The transfer
script `output/vm-qualification/transfer-two-version.ps1` copies it to a new guest
folder and prints the exact destination. Run `HoneyBee-Two-Version-QA.cmd` from
that folder as the original user. Per-case results/failures and activation journals
remain under `Cases`; full success creates `two-version-result.json`.

PowerShell 5.1 parsing, JavaScript syntax, lint and formatting checks passed. A
host execution correctly refused the guest identity mismatch before creating any
case directories. Subsequent guest execution results are recorded below.

## First guest attempt: absent registry guard correction

The user reported successful delivery to
`C:\HoneyBeeQA\two-version-20260911-140423` (97 files), then an `ENOENT` failure
while snapshotting the absent `workspace-core` directory. This occurred before
case creation or pointer activation. An unused fresh installation can legitimately
have no registry file; requiring it was a qualification-script defect.

`qa-registry.mjs` now treats only `ENOENT` as an absent registry snapshot (`null`)
without creating a file or folder. Existing registries must be schema 2 with empty
project/workspace arrays. Existing ancestor directories are checked for redirects;
invalid JSON, other read errors, redirected paths and occupied registries still
fail. Subsequent snapshots distinguish absence from a newly created empty file,
so creation/deletion or content changes are not silently accepted as preservation.

Seven regression tests passed and are included in `test:update`. The local transfer
bundle contains the corrected runner and helper; rerunning the same transfer
command delivers them to a fresh guest folder. Retain the earlier failed attempt.
The subsequent guest run passed all three scenarios, as recorded below.

## Successful guest run: user-provided results (2026-09-11)

The user supplied the following scenario results from
`C:\HoneyBeeQA\two-version-20260911-141217`:

| Scenario                                       | Case directory      | Reported result   |
| ---------------------------------------------- | ------------------- | ----------------- |
| Normal commit                                  | `Cases\case-Ept32k` | `commit PASSED`   |
| Injected post-switch health failure            | `Cases\case-6nE4oA` | `rollback PASSED` |
| Child-process termination after pointer switch | `Cases\case-pVgRpm` | `crash PASSED`    |

The runner and PowerShell entry point both printed `Two-version qualification
PASSED`. The runner only emits these success markers after checking the expected
pointer outcome, retained source and target payloads and unchanged watched
original installation/registry/service files. Doctor ran against the explicit
selected versions through the native Job Object helper. The crash case recovered
from its pinned journal after the activation process was killed.

Retain `two-version-result.json`, all per-case `result.json` files and activation
journals in that guest folder. The supplied console output establishes a
user-reported pass; the full reports have not been independently read on the host.

These results qualify the three isolated app-only scenarios with the fixed QA
baseline observer and an empty project/workspace registry. They do not establish
production release authentication, sustained application quiescence, populated
workspace migration, Desktop launch/restart readiness, service replacement,
Windows reboot/power-loss recovery or automatic updater UI behavior. In particular,
the tested process kill is not a VM power interruption. The next production work
must retain these distinctions when adding admission and process lifecycle gates.
