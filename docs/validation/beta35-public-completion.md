# beta.35 public delivery review

Candidate Setup SHA-256:
`643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04`.
Manifest SHA-256:
`5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4`.

The 2026-09-18 attributed guest report in
`output/reboot-fix-20260917/reported-public-winget-pass.json` confirms public
download, observed cancellation/retry, interactive WinGet installation, ready
Doctor and preserved data after activation of beta.35. The original silent
WinGet failure is retained; the retry uses the manifest's interactive installation
mode. This is local-manifest installation from the public Setup URL, not a claim
of submission to the community WinGet repository.

The guest explicitly did not observe download progress. That report remains
unchanged. Additional automated coverage on the host closes that specific gap:

- `public-progress-pL67tf/result.json` records an isolated integration run using
  the unmodified shipped renderer and preload, and the exact controller class
  extracted from the shipped main bundle. The normal IPC response contracts
  connect these components to shipped authenticated discovery/staging modules.
- Source version facts are a beta.32 fixture, and project listing is empty.
  The run does not prepare, activate, install or mutate a registered Workspace.
- Discovery uses live anonymous GitHub metadata and the production trust key.
  Package bytes come from the real public URL. Their delivery is paced for ten
  seconds so the normal one-second UI poll can be captured; byte counts and
  progress values are not synthesized.
- Visible progress increased from 10,829,824 to 29,736,960 of 212,790,902 bytes.
  Both screenshots were visually reviewed. The full download subsequently
  passed the shipped signature/hash verification and reached `Downloaded`.
- `public-progress-candidate-binding.json` binds the tested ASAR to the ASAR
  inside the pinned distribution ZIP: SHA-256
  `77f33660e5848da553783e244612b73dad1fced7386f5ebec0b638dd24bc327b`.

These files, the harness `verify-public-progress.cjs`, screenshot hashes in
`public-progress-review.json`, and earlier attempts are retained under
`output/reboot-fix-20260917/`. The first harness attempt failed on archive-root
hash reading. The next passed DOM checks but one capture preceded rendering;
the final run waits for rendering and retains two visible progress captures.
Neither earlier attempt is silently substituted for the final visual evidence.

Gate 04 combines this narrowly scoped automated progress evidence with the
actual guest public delivery journey. Gates 01–15 are covered; gate 16's WinGet
requirement is covered with the previously approved Authenticode deferral.
This qualifies the unsigned beta policy, not signed or stable release readiness.
Final publication completion additionally requires matching all public assets
and publishing the final release notes through `complete-public-beta.mjs`.

That final step completed on 2026-09-18: all six anonymously downloaded public
assets matched their pinned local hashes and sizes, and the final notes were
published and read back successfully. The completion receipt is recorded in
`output/reboot-fix-20260917/beta35-completion.log` and the distribution's
`publication/public-verification-*/completed.json`. The release remains a
prerelease at <https://github.com/Kubonsang/HoneyBee/releases/tag/v0.1.0-beta.35>.
