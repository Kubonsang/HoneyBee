# ADR-063: Pinned startup recovery runtime

Status: opt-in runtime/launcher implemented and packaged for QA; automatic Doctor rollback in VM pending.

## Architecture

An explicit recovery-enabled bootstrapper build embeds the SHA-256 of a recovery
runtime inventory. The runtime lives at `recovery/v1`, outside active application
versions. Before execution, the launcher validates the inventory against its compiled
pin and every listed runtime file, including private Node, the fixed startup module,
native update/Doctor helper and approved-source inventory. No journal can select an
executable, command line or different runtime. Environment overrides `NODE_OPTIONS`,
`NODE_PATH` and `ELECTRON_RUN_AS_NODE` are removed for this process.

The launch guard exposes a typed recovery request only for a structurally valid
nonterminal app-pointer journal. Missing/corrupt metadata still fails closed. The
launcher makes one bounded recovery attempt, then repeats normal journal, pointer
and executable validation before retrying the requested Desktop/CLI launch. Exit
code zero alone never permits launch. Recovery runs without elevation, with a
180-second limit and hidden console; existing helper pipe ownership and Doctor Job
Object behavior remain necessary for child cleanup.

The first policy intentionally approves one exact source release at bootstrapper
build time. Its full file inventory and launch-manifest hash are inside the pinned
runtime. `scripts/recovery/startup.mjs` refuses other source versions/manifests,
verifies all approved files, requires activity protocol 1 and holds exclusive
application activity while using the existing native-locked `recoverAppPointer`.
The rollback health callback invokes the real pinned source Doctor before pointer
replacement; it must report ready. It revalidates files and health after recovery,
checks the exact restored pointer and retains diagnostic reports under
`update/recovery-attempts/startup-*/result.json`.

This authorizes source-only app-pointer rollback, not service migration, target
execution or repair of user data. Doctor mismatch/failure, unapproved source,
activity refusal or unknown pointer stops recovery. It does not generalize the
QA-only service observer into a production authorization callback. A new source
outside the build-time approval requires a newly trusted bootstrapper/runtime;
expanding that policy requires release-signature/admission work.

## Build and packaging

1. `node scripts/installation/build-recovery-runtime.mjs <approved-source-installation>`
   creates `output/recovery-runtime/build-*` and its candidate pin.
2. `node scripts/launcher/build.mjs --recovery` creates a distinct
   `output/launcher-recovery` containing the pinned launcher/shim and runtime.
3. `HONEYBEE_INCLUDE_RECOVERY_RUNTIME=1` opts installation assembly into those
   artifacts. Assembly requires matching source version, launch hash and approved
   source file hashes. The default launcher output/build remains separate.

No existing installation or delivered VM bundle was retrofitted. Runtime inventory
hashes depend on trusting the bootstrapper artifact; they are not publisher signing
or protection against replacement of that bootstrapper by same-user malware.

## Evidence and limitations

- Go tests/vet passed, including real private-Node handoff with a fixture recovery
  script, argument preservation, runtime tampering/missing-pin refusal, and refusing
  a zero-exit script that did not repair its journal. One symlink test was skipped
  because Windows did not grant symlink creation; existing junction tests passed.
- Default Launcher A/B and CLI argument/stream smoke passed. JS lint/format passed.
- Pinned runtime: `output/recovery-runtime/build-OAmOMy`.
- Compiled runtime inventory pin:
  `936fe0fa313c195cee46dd298825a7498a6f06c766c0a015825e6ca3c6fae287`.
- Full approved-source matching passed during opt-in QA assembly, but final staging
  rename failed twice with Windows EPERM. A subsequent native move also reported
  that a file was in use and left the second generated output partly moved. Those
  generated attempts remain evidence; neither is reported as a completed package.
- An intact first staging tree was copied into a new isolated QA package:
  `output/recovery-qa/package-2452ff758846483db754acf194845564/HoneyBee`.
  All 101 runtime files and 186 source files matched the approved inventories;
  its stable CLI reported beta.12. Evidence: `output/recovery-qa/package-verification.json`.

The copied QA package verifies content and execution, not successful atomic installer
publication. The staging rename lock remains unresolved. The native handoff test
uses a fixture script; a positive test of this production startup module with real
Doctor and the recovery-enabled launcher remains a VM gate. The next qualification
must interrupt an isolated update and invoke the ordinary stable launcher/shim,
without calling the guest recovery function, then verify rollback, Desktop readiness,
repeat-launch behavior, refusal on tampering/Doctor failure and preserved baseline.
