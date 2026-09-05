# Beta 4 quality follow-up readiness

Status: `0.1.0-beta.5` local archives verified; **follow-up not cleared for publication**.

Public release inspection on 2026-09-05 found that Beta 4 was already published on 2026-09-04 at
13:32:07 UTC, from commit `794f8f8f6b5ef7f872be8daeebceae76d975abb9`. Its source tree
`63603f0b45bfa0ec1282dce71052b41febed0b38` exactly matches local base `b42e00b`, despite the squash
commit history. These changes therefore apply to the released code, without replacing public assets.

This checklist applies to the final CLI and Desktop archives, not just the previously tested
storage component. Preserve the 2026-09-04 evidence in `windows-cli-beta-dogfood.md` as historical
evidence; do not relabel it as a test of newly assembled archives.

## Automated gates

- [x] `corepack pnpm verify`: secret/license checks, formatting, lint, types, build, TypeScript
      regressions, Go host tests, and dependency boundaries.
- [x] CLI package smoke, Desktop package IPC/UI smoke, and packaged PTY smoke.
- [x] Desktop visual/interaction smoke at 1280 × 820 and 900 × 620.
- [ ] Windows CI passed on the candidate commit; logs and tested archives retained.

The final versioned run passed **62 TypeScript tests in 16 suites**, Go host tests, and all
verification stages. Packaged UI smoke exercises untracked guidance, out-of-order diff replies,
and navigation while a request is pending. Visual captures are under `output/beta4-qa/1280` and
`output/beta4-qa/900`. Verification and packaging logs are retained in
`output/beta4-release-validation/verify-beta5.log` and `package-smoke-beta5.log`.

Regressions cover the first unstaged file's status columns, C-quoted Unicode and spaced paths,
renames, literal pathspecs, staged/unstaged diffs, multi-megabyte output with a 1 MiB UTF-8-safe
display bound, outdated responses, and shared setup blockers. Untracked contents are explicitly
outside this candidate's diff viewer and remain available through the user's editor.

## Physical Windows gates

- [ ] Fresh Windows 11 x64 setup from the exact archives, following the included guide; elevated
      service install only, then normal-user Doctor and Desktop onboarding.
- [ ] Beta 3 upgrade: remove disposable old Workspaces using Beta 3, preserve branches, verify zero
      old children, replace the matching service, then use the follow-up candidate normally.
- [ ] Run `scripts/dogfood/windows-cli-beta.ps1` on a disposable real Unity project with empty
      dedicated Git Workspace/registry roots and zero active, retained, and pending storage children.
      Capture all four post-Unity allocations before removing any Workspace.
- [ ] Four linked worktrees, Codex/Claude isolated commits, two concurrent Unity Editors,
      dirty/open-handle refusal, repeatable removal, branch preservation, and no child residuals.
- [ ] Final candidate create → commit → physical reboot → repair → Unity → remove, retaining
      boot identities, child identity, authored hashes, branch HEAD, timings, and final status.

The 2026-09-05 read-only inspection found a healthy hb8 service with **one pre-existing retained
child**, zero active/pending/quarantined children, and no manual-recovery condition. That machine
does not meet the strict zero-child baseline. Do not delete the unrelated Workspace, downgrade its
service, or replace its installation to make a release test pass. A dedicated Windows environment
is needed for the outstanding install/upgrade/full-dogfood gates.

The Go host tests passed outside the restricted execution sandbox with an isolated writable build
cache on 2026-09-05. The previous `Access Denied` result was not reproduced there; no test or
directory ownership check was disabled.

## Candidate identity and publication

- [x] Record the candidate commit (or base commit plus local source hashes while uncommitted),
      Node/Go versions, storage commit/version, package hashes, and evidence locations.
- [x] Produce CLI and Desktop ZIPs and `SHA256SUMS.txt`; verify extracted contents and smoke-test the
      executables that will ship. Desktop must include `README.md` and `STORAGE-SETUP.md`.
- [x] Reconcile README/CHANGELOG/install guides with actual release history and gate results.
- [ ] Publish only the tested archives after every gate above passes; rebuilding invalidates the
      archive hashes and requires package verification again.

The local artifacts are under `artifacts/v0.1.0-beta.5-candidate-20260905/`:

| Archive                                        | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `HoneyBee-CLI-v0.1.0-beta.5-win32-x64.zip`     | `f1402dc047c139a802d0dd0d03c6c4ce56e3d83356893cd0fc6de4a948eb5153` |
| `HoneyBee-Desktop-v0.1.0-beta.5-win32-x64.zip` | `49df6011a3698f1dde99a5674bdc09736070e2c076b2cf89549454fd97992a37` |

`candidate-manifest.json` records base revision, source file hashes, tool versions, storage pin,
and local/pending validation status. `SHA256SUMS.txt` applies to these exact archives. Both were
extracted under the app-specific `release-beta5-extracted` directories and passed CLI smoke,
Desktop IPC/UI interactions, and packaged PTY smoke again. These are local uncommitted candidates;
no GitHub CI run, tag, release, or service migration was performed in this session.

The extracted PTY check initially hit Electron GPU/OS-crypt initialization failures in the
restricted sandbox account. It passed when rerun in the same normal Windows user context used for
packaging. This is recorded separately from the successful application checks; no test was skipped.

Local tags identify Beta 1 at `345e7c7` (2026-09-03) and Beta 3 at `9ec2444` (2026-09-04). There is no
local Beta 2 release tag; its changes are documented as a development milestone included in Beta 3.
GitHub's public release list confirms Beta 1, Beta 3, and Beta 4; there is no published Beta 2.
Do not invent a Beta 2 publication date. Never overwrite the published Beta 4 archives with these
follow-up builds.

No signed installer, auto-update, automatic service replacement, automatic reboot repair, or agent
orchestration is part of this candidate.
