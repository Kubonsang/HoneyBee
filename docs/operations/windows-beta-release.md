# Windows beta release procedure

Use the fixed acceptance contract in
`../validation/installation-update-v1-acceptance.md`. Keep previous evidence and
rerun only cases affected by the change. Version increments alone do not require
repeating service interruption, reboot, and power-off qualification.

## Source checks

`pnpm verify` is the canonical source check. Vitest runs the app/Core tests and
the Vitest-based security/dogfood scripts. The package's `node --test` commands run
installation, update, and qualification tests. Do not load node:test suites through
Vitest or omit qualification tests to make collection pass.

Record unrelated workspace failures separately; do not silently edit unrelated
user files or claim the aggregate command passed when it stopped. Commit only
intended source, test, and documentation paths. Keep generated packages, signing
secrets, VM disks, and personal analysis files out of the release commit.

## Artifact review and draft delivery

Freeze the candidate Setup, application archive, manifest, signature and checksums.
Bind the acceptance worksheet to their hashes and record the actual build recipe
and source commit. QA baselines and consecutive-update targets are not public
release artifacts merely because their version numbers are greater.

`publish-beta.mjs <config> <notes> <remote-commit> stage` requires verified artifacts
but may create a **draft prerelease** before final acceptance is ready. It uploads
the exact assets and downloads them to compare hashes. This enables delivery review
without declaring the release qualified. A matching interrupted draft may resume;
unrelated existing assets or differing notes/source are refused.

`publish-beta.mjs <config> <notes> <remote-commit> publish` still requires all
applicable final acceptance gates. The approved unsigned-beta exception defers
Windows Authenticode only. A draft or successful upload is not a public release,
and a valid WinGet YAML file is not a successful WinGet installation.

## Capacity and repeatability

Before builds/transfers, budget both host and guest free space including temporary
copies and checkpoint growth. Reuse immutable verified packages. Retire only
duplicate or terminal generated payloads with recorded retained copies; never
delete active versions, recovery inputs, user projects or VHD/checkpoint chains
as routine build cleanup.

For ordinary app changes, run related automated tests, one supported update/launch
check, and distribution verification. For updater/service changes, add only the
affected preservation and recovery cases from the fixed contract. Reconcile prior
passes explicitly instead of resetting the acceptance worksheet every time.
