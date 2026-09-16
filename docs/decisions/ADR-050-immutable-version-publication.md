# ADR-050: Verified version publication without activation

## Status and boundary

Implemented as internal `publishPreparedVersion` and `recoverVersionPublication`
functions in `scripts/update/publish-version.mjs`. They publish the complete pinned
payload from ADR-047 into `versions/<version>` under the existing Windows
installation lock. There is no Desktop, Setup or production updater caller yet.
The package smoke exercises publication with synthetic source observations.

Publication returns `activationAllowed: false`. It does not change `current.json`,
the Launcher, CLI shim, service, project registrations or user data. ADR-049's
activation primitive remains separate and requires explicit admission and health
callbacks. Publication is not release authentication or authorization to activate.
Only a revalidated `app-only-candidate` plan is admitted; service migration remains
outside this step.

## Publication protocol

1. Acquire the installation lock and revalidate the caller-pinned plan, live source,
   release manifest, prepared payload and full inventory.
2. Refuse any existing target version directory, including an empty directory.
3. Create a unique `update/publications/publish-*` journal and exclusively write
   and sync `Intent.json`. It binds the plan path, digest, target version and
   `kind: exclusive-files-v1`.
4. Exclusively create the inactive target directory. Write and sync `Reserved.json`
   with the plan digest and directory device/file identity.
5. For each inventory file, validate the source, stream into a unique exclusive
   journal temporary file, check byte count and SHA-256, sync and close it. Create
   a same-volume hard link at the destination, which refuses an existing name.
   Remove only this call's temporary name. Publish `launch.json` last.
6. Verify reserved directory identity and the entire published inventory, then
   revalidate the plan and source again. Write and sync `Published.json` with the
   target and journal paths, plan digest, state and `activationAllowed: false`.

This uses complete-file publication because directory rename failed with Access
denied on the actual Windows application payload, including bounded retries. No
directory move helper or overwrite fallback is used. An inactive directory may be
partially populated during copying; only the active pointer selects a launchable
version. Publishing `launch.json` last does not replace admission validation.

## Recovery and refusal rules

Explicit recovery requires the same plan path and digest, the exact journal intent,
a valid reservation and matching target directory identity. It revalidates source
state and prepared files before resuming. It copies missing files only and verifies
existing files against the pinned inventory. Modified files are never overwritten;
unexpected payload entries fail full validation. A completed publication is
reverified, not repaired, on repeated recovery.

Process termination can leave a journal temporary file, or a temporary hard-link
alias after destination creation. These remain as evidence; recovery never adopts
or edits them. Future evidence collection must not modify these files because an
alias can share bytes with the published payload. Automatic cleanup is deferred.

There is an intentional fail-safe gap between target directory creation and durable
reservation recording: if `Reserved.json` is absent or malformed, recovery refuses
to claim the directory. A fresh publication also refuses it. Diagnosis is required,
while the old active version remains selected. The error's journal location is
evidence, not a guarantee that automatic recovery is possible.

Missing or changed source evidence, changed plans, unsupported service tooling,
directory redirection and identity changes fail safely. The per-user lock coordinates
cooperating HoneyBee processes; these records and file IDs do not authenticate a
release or protect against a malicious process with the same user's write access.

## Filesystem and durability limits

Publication requires same-volume hard-link support and usable directory identities
(the intended Windows NTFS layout). Unsupported filesystems fail without a copy or
overwrite fallback. File contents and journal records are synced, but abrupt VM
power loss, filesystem metadata durability and reboot orchestration are not yet
qualified. Retained staging, prepared and published copies increase disk use;
space admission and retention policy remain production integration work.

## Validation

- Nine publication tests cover complete publication and idempotent recovery,
  existing empty/nonempty targets, reservation races, copy interruption, tampering,
  and real child-process termination after reservation, file linking and complete
  verification. They assert preservation of the old pointer, version and user data.
- The complete Node update suite passes 68 tests; package-tool Go tests and vet pass.
- An actual assembled beta.11 payload from a 213,186,181-byte ZIP passed publication
  and repeated recovery in an isolated installation with a Korean path. The pointer
  and user-state sentinel remained unchanged. This reused the plan produced by the
  package smoke after the failed directory-rename experiment; the final per-file
  publisher and recovery were run against that real payload.
- `smoke-prepare.mjs`, already invoked by Windows CI after assembly, now includes
  plan creation and publication. Source version/service observations in this smoke
  are synthetic. Neither Desktop nor the privileged service was executed by these
  tests, and no existing user or VM installation was changed.

Production composition still needs authenticated release admission, application
quiescence, real source/target health validation and orchestration linking this
publication to ADR-049 activation/recovery. Service migration remains a separate
recoverable operation; this step does not authorize it.
