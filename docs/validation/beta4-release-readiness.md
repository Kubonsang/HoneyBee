# Beta 4 quality follow-up readiness

Status: `0.1.0-beta.5` changes were merged in [PR #39](https://github.com/Kubonsang/HoneyBee/pull/39)
as `246226e`; all seven PR checks passed at head `46fca73`.
**Follow-up not cleared for general publication**. The initial local archives below are superseded by the
PR's parser hardening. Use archives from the final successful Windows CI run for subsequent testing.

The [current-PC existing-install route](windows-shared-host.md) completed its functional and actual
reboot gates on 2026-09-05 using the final CLI archive. Final Doctor passed 19 checks with no
warnings/failures, the test registry is empty, and the original retained child is preserved. This
supports limited evaluation with the existing matching hb8 service.
[Beta 5](https://github.com/Kubonsang/HoneyBee/releases/tag/v0.1.0-beta.5) was published on
2026-09-05 at 11:16:53 UTC, targeting `246226e`. Both original CI ZIPs and SHA256SUMS were
verified against their public download digests. General publication remains blocked by the
fresh-install, upgrade, and external-tool conformance gaps.

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
- Final-head Windows CI, CodeQL, and review status: [PR #39 checks](https://github.com/Kubonsang/HoneyBee/pull/39/checks).
  A successful `windows-quality-<head SHA>` artifact contains the tested CLI/Desktop ZIPs, checksums,
  PR head (`pr-head.txt`), tested checkout (`source-commit.txt`), and logs. Pull-request builds use
  GitHub's merge checkout, so those two commits can differ. Local pass marks above do not substitute
  for these PR checks.

The initial versioned run passed 62 TypeScript tests. After CodeQL review, the rename parser was
changed from an ambiguous regular expression to a single delimiter scan. A 50,000-separator input,
escaped quotes, and unterminated quoted paths are covered. The follow-up local run passed
**63 TypeScript tests in 16 suites**, Go host tests, and every `pnpm verify` stage, with its log at
`output/beta4-release-validation/verify-pr39-parser.log`.

Packaged UI smoke exercises untracked guidance, out-of-order diff replies,
and navigation while a request is pending. Visual captures are under `output/beta4-qa/1280` and
`output/beta4-qa/900`. Verification and packaging logs are retained in
`output/beta4-release-validation/verify-beta5.log` and `package-smoke-beta5.log`.

Regressions cover the first unstaged file's status columns, C-quoted Unicode and spaced paths,
renames, literal pathspecs, staged/unstaged diffs, multi-megabyte output with a 1 MiB UTF-8-safe
display bound, outdated responses, and shared setup blockers. Untracked contents are explicitly
outside this candidate's diff viewer and remain available through the user's editor.

## Physical Windows gates

These are the full installation/upgrade and zero-baseline acceptance gates. When another Windows
environment is unavailable, the user-approved [current-PC route](windows-shared-host.md) can support
a limited evaluation for existing matching hb8 installations after its functional and deferred
reboot phases pass. It does not mark the unchecked installation, upgrade, interactive-agent or
zero-baseline gates below as passed.

- [ ] Fresh Windows 11 x64 setup from the exact archives, following the included guide; elevated
      service install only, then normal-user Doctor and Desktop onboarding.
- [ ] Beta 3 upgrade: remove disposable old Workspaces using Beta 3, preserve branches, verify zero
      old children, replace the matching service, then use the follow-up candidate normally.
- [ ] Run `scripts/dogfood/windows-cli-beta.ps1` on a disposable real Unity project with empty
      dedicated Git Workspace/registry roots and zero active, retained, and pending storage children.
      Capture all four post-Unity allocations before removing any Workspace.
- [ ] Four linked worktrees, Codex/Claude isolated commits, two concurrent Unity Editors,
      dirty/open-handle refusal, repeatable removal, branch preservation, and no child residuals.
- [x] Final CLI candidate shared-host create → commit → physical reboot → repair → Unity → remove,
      retaining boot identities, child identity, authored/Library hashes, branch HEAD, Unity run
      timing, and final status. See the current-PC route for the completed evidence and scope.

The 2026-09-05 read-only inspection found a healthy hb8 service with **one pre-existing retained
child**, zero active/pending/quarantined children, and no manual-recovery condition. That machine
does not meet the strict zero-child baseline. Do not delete the unrelated Workspace, downgrade its
service, or replace its installation to make a release test pass. A dedicated Windows environment
is needed for the outstanding install/upgrade/full-dogfood gates. Existing-install functional checks
can instead use the shared-host route, which preserves the original inventory and permits only
recorded test children rather than deleting the unrelated Workspace to obtain a zero baseline.

The Go host tests passed outside the restricted execution sandbox with an isolated writable build
cache on 2026-09-05. The previous `Access Denied` result was not reproduced there; no test or
directory ownership check was disabled.

## Candidate identity and publication

- [x] Record the candidate commit (or base commit plus local source hashes while uncommitted),
      Node/Go versions, storage commit/version, package hashes, and evidence locations.
- [x] Produce CLI and Desktop ZIPs and `SHA256SUMS.txt`; verify extracted contents and smoke-test the
      executables that will ship. Desktop must include `README.md` and `STORAGE-SETUP.md`.
- [x] Reconcile README/CHANGELOG/install guides with actual release history and gate results.
- [ ] General publication: pass every gate above. Limited existing-install evaluation: pass the
      shared-host functional and deferred-reboot route and explicitly disclose its unverified gates.
      Publish only the tested archives; rebuilding invalidates the archive hashes and requires
      package verification again.

The **superseded initial local artifacts** are under `artifacts/v0.1.0-beta.5-candidate-20260905/`:

| Archive                                        | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `HoneyBee-CLI-v0.1.0-beta.5-win32-x64.zip`     | `f1402dc047c139a802d0dd0d03c6c4ce56e3d83356893cd0fc6de4a948eb5153` |
| `HoneyBee-Desktop-v0.1.0-beta.5-win32-x64.zip` | `49df6011a3698f1dde99a5674bdc09736070e2c076b2cf89549454fd97992a37` |

`candidate-manifest.json` records base revision, source file hashes, tool versions, storage pin,
and local/pending validation status. `SHA256SUMS.txt` applies to these exact archives. Both were
extracted under the app-specific `release-beta5-extracted` directories and passed CLI smoke,
Desktop IPC/UI interactions, and packaged PTY smoke again. These are local uncommitted candidates;
no GitHub CI run, tag, release, or service migration was performed in this session.

The later continuation committed the implementation on `fix/beta5-release-quality`, opened PR #39,
and started GitHub CI. The first CodeQL run identified polynomial-time rename matching; that real
finding is addressed by the scan and regression above. The initial archives' manifest now records
their superseded status. No public Beta 4 asset has been replaced.

Read-only diagnosis of the extracted candidate against the existing hb8 installation passed 12
checks with one expected warning for the empty probe registry and no failures. This verifies
installed-service compatibility without mutating it; it is not a fresh-install or upgrade test.
Hyper-V enumeration failed for lack of management permissions in the current Windows account,
and no installation ISO was found in the user's Downloads folder. The dedicated physical gates
remain pending; no existing Workspace or service was removed to manufacture an empty baseline.

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
