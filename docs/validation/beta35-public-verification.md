# beta.35 public delivery verification

The user approved the candidate-specific publication order on 2026-09-17 after
reviewing the fourteen completed prepublication gates. The remaining public
download/cancel/retry and local WinGet installation checks are pending. Public
verification failure requires withdrawal; publication is not release completion.

- Version: `0.1.0-beta.35`, GitHub prerelease, never latest/stable.
- Setup SHA-256: `643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04`.
- Release manifest SHA-256: `5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4`.
- WinGet manifest SHA-256: `a47da7ade1f3e9b1c66e839340a04c212ce6d9af74f5841fb72a8d29187fa9c3`.
- Approval: `beta35-public-delivery-20260917`.
- Windows Authenticode: deferred under the existing unsigned-beta exception.
- Ed25519 manifest signature and exact asset hashes remain mandatory.

Source is the repository plus the explicit version substitution implemented by
`scripts/qualification/build-two-version-candidate.mjs` for beta.35. The retained
candidate was assembled before this source commit; final media hashes above are
the identity of the tested bytes. Release-only policy and qualification helpers
added afterward do not silently replace packaged runtime files.

Attributed guest completion of the six native service cases and production
handoff is retained at
`output/reboot-fix-20260917/reported-remaining-service-pass.json`. Coverage and
limitations are recorded in `beta35-evidence-reuse.md`. That report exercises the
instrumented beta.31 source and beta.32 target with the exact beta.35 production
service host; it does not claim migration support for public beta.11/hb12.

After publication, the existing ordinary-user VM entry reads the pinned public
metadata, authenticates it, observes the actual Desktop offer/progress/cancel/retry,
installs the public Setup URL through the local WinGet manifest, and compares
project data, service receipt and final Doctor readiness. Final results must be
reviewed before release completion is recorded.

Prepublication source validation on 2026-09-17 passed lint, typecheck, build,
dependency boundaries, 181 Vitest checks, 410 Node checks across the standard
installation/update/repair/key/combined/qualification suites, and Go test/vet
commands in the standard pipeline. Security and production-license checks also
passed. The aggregate `verify` command stopped at formatting of two unrelated
untracked user analysis documents; those were preserved. Task-file formatting
passed, and the remaining standard commands were run separately without removing
tests. Logs are retained under `output/reboot-fix-20260917/prepublication-*`.
