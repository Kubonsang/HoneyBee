# Beta 6 usability readiness

Scope: existing matching hb8 installations. Storage pins, CLI JSON, registry format, and storage
protocol remain unchanged. This is not a fresh-install or Beta 3 upgrade qualification.

## Existing release and issue reconciliation (2026-09-06)

Beta 5 was published on 2026-09-05 from `246226e`; its public archives are preserved.

| Issue acceptance group                                                    | Existing evidence                                                                                                  | Remaining qualification                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| #35 identity-aware stale-mount validation and atomic pins                 | Beta 4/5 component `68e05e0`, compatibility hashes, upstream/Core tests                                            | Keep original evidence tied to its tested component                                                        |
| #35 real reboot, retained volume/junction identity, authored preservation | [Physical reboot record](windows-cli-beta-dogfood.md) and [Beta 5 existing-install record](windows-shared-host.md) | A new authored commit after repair is not explicitly recorded in the Beta 5 gate                           |
| #35 removal, branch preservation, ADR-031 evidence                        | Both physical-reboot records include clean/idempotent removal and original-child preservation                      | Reconcile the post-repair commit item before closing the issue                                             |
| #36 real Codex/Claude work and context isolation                          | Earlier Beta 4 dogfood records; Beta 5 uses scripted edits and batch Unity                                         | Do not relabel Beta 5 as provider conformance; repeat exact final-package flows before general publication |
| #36 dirty/in-use protection, identity/exclusive removal                   | Core/broker tests and Beta 5 shared-host handle refusal, retry, cleanup                                            | Full agent-descendant, lost-response/client-crash acceptance must retain separately attributable evidence  |

Issues #35 and #36 remain open. Dependency PRs #30 and #38 are outside this usability change.

## Terminal implementation

- Main owns one session per project/Workspace, including exited output, until explicit close or app exit.
- Renderer owns persistent xterm instances above navigation. Hidden views stop polling and resizing.
- Sixteen sessions maximum; each main buffer remains bounded to 2 MiB and 1,000 chunks.
- Workspace removal refuses running built-in terminals before invoking Core, and prevents creation
  while removal is pending. Existing Core protections continue to cover external tools.
- App close/quit confirms running terminals; cancellation preserves sessions. Accepted quit blocks
  new sessions and closes existing PTYs once. No external-process supervision is added.
- Electron error transport preserves code/message/remediation across contextBridge.

## Validation and publication gates

Local automated evidence is retained under `output/beta6-*`. Terminal tests evaluate PowerShell PID,
working directory, and variable values rather than matching command echo. Desktop smoke exercises
production IPC and renderer navigation with real PowerShell in an isolated temporary directory;
it does not register or remove any existing user Workspace or Library storage.

Before publishing Beta 6, record final PR heads, successful Windows CI archives/checksums, package
smoke results, and a final existing-install evaluation. Merge and publication are separate steps;
this document does not claim that a Beta 6 release exists.
