# ADR-067: Setup includes the startup recovery runtime

Date: 2026-09-13

Status: Implementation, unit checks and isolated packaged Setup smoke passed.

## Problem

ADR-066 qualified an assembled installation containing the pinned `recovery/v1`
runtime. However, `inventoryTree` and `installFresh` enumerated only `versions`,
`bin`, `HoneyBeeLauncher.exe` and `current.json`. The NSIS build copied recovery
into its extraction bundle, but the actual fresh-install primitive omitted it.
The installed launcher could therefore lack its runtime when an interrupted update
required recovery. Previous QA used copied assembled installations, not this Setup
publication path, so those passes did not cover the omission.

## Change

Treat `recovery` as an optional application payload directory. When present it must
be an ordinary, nonempty directory; its files enter the same SHA-256 inventory as
the application. Copy, sync and verify these files before the `current.json`
activation rename. Service-only retries compare the recovery inventory too.

Always reserve the destination's `recovery` name, including for legacy packages
without the runtime. Refuse an existing entry before creating setup evidence.
Interrupted copies remain inactive and their evidence is preserved. No cleanup,
automatic overwrite, new elevation path, or service replacement was introduced.

Legacy packages without a recovery directory still install with the original
payload contract. A missing runtime cannot be inferred from an arbitrary launcher
binary here; the recovery-enabled assembly and launcher pin remain the source of
that binding. The file inventory is integrity evidence, not publisher signing.

The packaged Setup smoke test now compares the installed inventory to the adjacent
build's `bundle/inventory.json`, so silently omitting an entire payload component
fails the test. The smoke command therefore requires the Setup build directory,
not just a detached EXE. Silent execution uses a unique workspace output path and
does not request service installation or launch Desktop.

## Validation

- Fresh installation and service orchestration tests: 27 passed.
- New cases cover recovery availability before activation, installed-runtime
  tampering blocking service retry, interruption, missing/changed copy input,
  corruption before admission, existing recovery evidence with both package types,
  and redirected recovery input.
- Changed JavaScript passed ESLint and Prettier.
- Actual NSIS build: `output/setup/build-RlYGPx/HoneyBeeSetup-preview.exe`.
  SHA-256: `AD15D5C56E03EA55788EF58165C7EE5460842BE448A95BD09575CF8DC1C1F187`.
- Its inventory contains 291 files, including 102 under `recovery/` (the runtime
  inventory's 101 files plus `manifest.json`).
- Packaged smoke passed at `output/setup-smoke/case-qOOiCx/HoneyBee 설치`, reporting
  `passed: true` and `ready: true`. Missing Git blocked publication, normal setup
  installed the exact inventory, the stable CLI reported its version, reinstall
  was refused and the seeded user registry file was unchanged. Silent Setup did
  not request service installation; readiness concerns the existing compatible
  service on this host, not a fresh-service install.
- The first sandbox run (`case-3fgRQv`) passed file comparison but failed stable CLI
  execution with `installation.update-in-progress`. A new run outside the tool
  sandbox passed the entire smoke. Both cases are preserved; the first native
  activity failure is not claimed fixed by this payload change.
- `git diff --check` passed.

This phase does not qualify a fresh VM service installation or automatic recovery
after an update initiated from the Setup-installed package. Those remain separate
integration gates; ADR-064/065 results concern assembled QA source installations.
