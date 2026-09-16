# ADR-041: Git prerequisite admission for Setup

## Status

Implemented for the fresh-install preview after the Windows VM qualification found
that service health passed while Doctor failed because Git was absent.

## Behavior

Doctor and Setup reuse `checkGitExecutable` from Workspace Core. It runs
`git.exe --version` with a bounded wait, checks that the response is a Git version,
and returns the existing `git.executable` check shape. No system PATH, registry or
Git installation is modified by this probe.

Setup invokes the packaged Core probe before app publication, project/registry
mutation or service elevation. Missing or unusable Git returns exit code 3 and
`ready: false`. Interactive NSIS explains that Git for Windows must be installed
with command-line PATH access and that Setup must be closed and restarted afterward.
It offers to open the official Git download page; declining opens nothing. Silent
setup returns code 3 without opening a browser or requesting UAC.

Git is checked again after service orchestration, before reporting success. The
health report includes the final prerequisite result. A service being ready does
not override a failed Git check. If Git becomes unavailable during installation,
app/service evidence is retained and readiness fails; no rollback deletes user data.

Git installation is a user-managed prerequisite in this increment. Setup does not
invoke winget, choose a Git version, accept external installer terms, or change the
user's existing Git installation. This preserves current Git/PATH behavior. Future
automatic prerequisite installation would need its own version/trust and restart
contract.

## Verification

Existing Doctor tests exercise the shared path. The actual NSIS smoke first starts
Setup with an empty PATH, expects exit 3, and verifies that no activation pointer or
setup publication journal was created and the sentinel registry was preserved. It
then reruns Setup with normal PATH and verifies successful app publication and the
usual service-health result. This models restarting Setup after Git becomes visible.
The existing reinstall refusal check remains in place.

`build-setup.mjs` requires the packaged Core export, so old assemblies without the
shared probe cannot accidentally produce this Setup. Core, CLI and Desktop packages
are rebuilt together. This remains a fresh-install preview: an existing different
application inventory is not overwritten even if it has the same beta version.
UAC cancellation/alternate-credential and interruption qualification remain open;
the current guest installation is preserved as prior validation evidence.
