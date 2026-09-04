# Windows CLI Beta dogfood gate

This gate must run against a disposable clone of a real, large Unity project. Toy fixtures and
GitHub-hosted package smoke do not satisfy it.

## Preconditions

- Windows 11 x64, Node.js 24, Git for Windows, and the project's real Unity Editor.
- A clean disposable clone with a generated, ignored source Library.
- Dedicated empty Git Workspace and HoneyBee data roots.
- A complete Beta 4 candidate CLI package whose doctor report has no blocking failure.
- No active storage leases at the metrics baseline.

Run the repository harness from a normal PowerShell:

    .\scripts\dogfood\windows-cli-beta.ps1 -HoneyBee <honeybee.cmd> -ProjectPath <project> -WorkspaceRoot <workspaces> -DataRoot <registry> -EvidencePath <result.json>

The harness creates combat, ui, enemy-ai, and level on unique branches and verifies that each `.git`
is a linked-worktree file, Git resolves the Workspace rather than the source worktree as its root,
and no Workspace-local `.honeybee` directory pollutes tool context. It then pauses. The operator must:

1. start Codex from `combat`, have it report its working directory and Git roots, run the project's
   exact Unity batchmode command, make one bounded tracked edit, and commit with subject
   `dogfood(codex): verify linked worktree`;
2. start Claude Code from `ui` and perform the same checks, ending with subject
   `dogfood(claude): verify linked worktree`;
3. open at least two Workspace projects in Unity simultaneously, wait for import/compile, and make
   isolated committed changes in `enemy-ai` and `level`.

The operator records tool versions, exact prompts, exact Unity commands, exit codes, and any child
processes left running. No credential, transcript content, or unrelated authored data belongs in the
evidence file. The harness writes the measured and machine-verifiable fields as evidence schema 2.

Before the operator phase the harness verifies four distinct Library junction targets and repairs one
deliberately removed owned junction. After confirmation it opens a real file in one generated
Library and requires removal to fail with `workspace.in-use` while the registry bytes, junction, and
branch remain unchanged. It then releases the handle and verifies dirty-remove refusal, clean
remove, repeated remove, existing-branch attach/remove, branch-head preservation, final doctor
state, timings, and storage allocated-byte deltas. It never deletes branches, kills processes, or
performs forced cleanup after a failure.

## Pass criteria

- project init, cache prepare, create, attach with a preserved existing branch, list, status, repair
  without reboot, and remove pass.
- Four Git worktrees and distinct branches coexist.
- Four Library junctions resolve to distinct retained mounts.
- Two Unity Editors import/compile concurrently without cross-Workspace Library changes.
- Authored Git changes remain isolated.
- Codex and Claude Code both resolve the linked-worktree root, complete Unity batchmode, and commit
  only the bounded change from inside their assigned Workspace.
- `.honeybee` is absent from every Workspace tool context.
- An open Library handle returns `workspace.in-use` without changing registry bytes, junction,
  worktree, or branch; the same removal succeeds after the handle closes.
- Dirty and untracked removal is rejected.
- Clean removal and repeated removal succeed, with branch HEADs unchanged.
- No cleanup-pending, repair-required, active lease, or manual-recovery state remains.
- The evidence records cache time, all create/remove times and medians, ready child allocation
  deltas, post-Unity allocation, and final storage allocation.

Performance values are observations for this Beta, not invented release thresholds. Any timeout,
capacity failure, cross-Workspace mutation, ownership ambiguity, or residual state fails the gate.

## Separate reboot gate

Dogfood above does not substitute for a reboot. On the same candidate component, run and retain
evidence for:

```text
create → agent edit/Unity batchmode/commit → shutdown/reboot → repair
       → Unity/import and authored-data verification → remove
```

After repair, the Library must resolve to the same retained child identity, authored Git data and
branch history must be unchanged, and final removal must leave no child, mount, lease, or pending
record. Beta 4 must not be published as reboot-capable until this gate passes.

## 2026-09-04 manual candidate run

This was a real-project partial gate against a disposable clone of `UndergroundMazeVerticalSlice`
on Windows 11 x64. It used Node.js 24.13.1, Git for Windows 2.45.1, Unity 6000.3.8f1, Codex CLI
0.153.2, Claude Code 2.1.42, and storage component
`0.0.0+68e05e0bf0e4.hb8`.

- Packaged `doctor --json` passed all 18 checks from a normal, non-elevated shell.
- The source Library parent prepared in 72,321 ms. Four ready children initially added 121,634,816
  allocated bytes in total.
- `combat` attached a branch preserved by an earlier failed create in 11,490 ms. `ui`, `enemy-ai`,
  and `level` created in 11,738 ms, 11,471 ms, and 10,368 ms respectively.
- All four `.git` entries were files, `git rev-parse --show-toplevel` returned the corresponding
  Workspace root, `.honeybee` was absent, and every Library junction resolved to a distinct mount
  and volume GUID.
- Codex and Claude Code each created a bounded marker, launched Unity batchmode against its own
  VHDX Library, observed exit 0 with no compiler-error signature, and committed only the requested
  marker pair. Their commits were `565c8de` and `be4c75d`; Unity folder metadata was preserved in
  follow-up commits.
- Two Unity 6000.3.8f1 Editor processes imported `enemy-ai` and `level` concurrently and exited 0.
- Holding an actual `ui/Library` file open made remove return `workspace.in-use`; registry bytes,
  junction, HEAD, branch, and worktree remained unchanged. Dirty `combat` removal returned
  `workspace.dirty`.
- Clean `level` removal completed in 2,703 ms, removed both Git and storage Workspace directories,
  and preserved branch HEAD `77b18e2`. Repeating the same remove returned the same successful
  bounded removal receipt without another mutation.
- After releasing the active handle, clean `ui` removal completed in 2,630 ms. Clean `enemy-ai`
  removal completed in 2,481 ms. Both removed their child, junction, and Git worktree while
  preserving their branch HEADs.
- Re-running `cache prepare` is a refresh, not a no-op. Under deliberate capacity pressure hb8
  rejected parent publication after 68,644 ms; parent count, allocated bytes, the prior cache,
  retained children, and all Workspace HEADs were unchanged, with zero pending parents.

Codex's isolated Windows sandbox account initially reported Git dubious ownership and could not
read the external VHDX mount directly. Its approved per-command execution path succeeded without
adding a global `safe.directory` entry. Unity log paths containing no spaces were passed as
unquoted tokens to avoid `cmd.exe` preserving escaped quote characters. Claude Code likewise needed
the Unity Bash call in its explicit allowed-tool set. These are external-tool permission behaviors,
not HoneyBee-owned launch integrations.

This run remains partial with respect to the strict zero-baseline automated harness: the machine
already had one unrelated retained child, and the raw four-child post-Unity allocation checkpoint
was not captured before `level` removal. The functional four-Workspace checks above passed. The
separate physical-reboot gate below used the retained disposable `combat` and removed all of its
validation state afterward.

## 2026-09-04 physical reboot gate — PASS

The same Beta 4 component and disposable real-project `combat` Workspace completed the physical
Windows lifecycle:

```text
ready → shutdown/reboot → repair-required → repair → ready → Unity/import → remove
```

- The Windows boot time and storage boot identity changed. Before the reboot the storage identity
  was `system-process-01dd3a2dd52e448f`; afterward it was
  `system-process-01dd3c619404abcb`.
- The pre-reboot registry SHA-256, Git branch, clean state, HEAD
  `7ce42af58c65487d0892025b45a2ea944c672e52`, and three marker hashes were recorded before shutdown.
- Before repair, packaged `workspace status --json` reported `repair-required` and `available:
false`. Packaged `workspace repair --json` completed in 4,908 ms and returned `ready` with the
  branch, HEAD, and clean state unchanged.
- The repaired Library junction resolved to the retained lease's exact volume GUID. Its marker
  hashes still matched the pre-reboot record.
- Unity CLI 1.0.0-beta.6 launched Unity 6000.3.8f1 against the repaired Workspace. Unity exited 0,
  the log contained no compiler-error signature, and the authored Git worktree remained clean.
- Clean removal completed in 2,620 ms and reported branch preservation. Repeating the same command
  completed in 143 ms from the bounded removal receipt and returned the same result.
- The disposable Git worktree metadata, Workspace path, storage shell, child VHDX, lease record, and
  retained record were all absent afterward. Its branch still pointed to the original HEAD.
- The unrelated pre-existing retained Workspace remained intact. Storage ended with zero active,
  pending, or quarantined validation children and no manual-recovery condition.
- The rebuilt packaged CLI ended with `doctor --json` reporting 18 passes, zero warnings, and zero
  failures, while `workspace list --json` returned an empty disposable Workspace list.

The lease journal keeps its original `bootSessionId` as acquisition provenance. It is not a current
attachment signal and is intentionally not rewritten by retained attach; the current broker status
and successful identity-checked attachment establish post-reboot readiness.
