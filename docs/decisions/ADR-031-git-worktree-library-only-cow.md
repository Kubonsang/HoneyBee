# ADR-031: Git worktrees with Library-only CoW

## Status

Accepted for HoneyBee Workspace Core v0.7. The retained-attach ordering fix is pinned for Beta 4,
and the elevated physical Windows reboot gate passed on 2026-09-04. Supersedes ADR-030. The
user-directed tool boundary from ADR-029 remains in force, but Git branches use ordinary
shared-repository worktrees rather than independent clones and publish steps.

## Context

ADR-030 placed the clean tracked project and Unity `Library` together in a full-project parent VHDX.
The first GNF_ benchmark showed that Git registration rewrote much of the tracked tree into the
child. A follow-up experiment removed that rewrite by registering the pre-populated child with an
index-only `git read-tree` operation.

The follow-up used the same GNF_ commit and immutable parents. It compared an ordinary Git worktree
with Library-only CoW (A) against Full-project CoW with no working-tree rewrite (B). Each mode ran 20
measured workspace creates, 4- and 8-workspace capacity checkpoints, three Unity batch-ready runs,
and cleanup. B was 11.54% slower to create and 1.62% slower to reach Unity-ready, although it used
58.27% less host space at eight workspaces and removed 25.91% faster. The pre-registered decision
rule required B to win two of the three primary metrics and stay within 10% on the third; B won only
capacity and exceeded the create-time tolerance.

In the 2026-09-02 benchmark, both retained children survived an actual reboot, but repair stopped at
a shared broker ordering defect: retained attach validated that the old mount path was absent before
the native attach path could run its existing detached-stale-mount cleanup. This was a broker
limitation, not evidence that B won or lost relative repair time. The Beta 4 pin and validation below
supersede that operational limitation while preserving the benchmark as historical evidence.

## Decision

HoneyBee creates each Workspace as an ordinary Git worktree at the requested new or existing branch.
Tracked project files, `.git` worktree metadata, commits, and uncommitted user changes live in that
persistent host directory. The storage broker owns only a differencing VHDX whose root contains the
Unity `Library` contents. HoneyBee links that mount at
`<worktree>/<unity-project-relative-path>/Library`.

Cache preparation copies only the ignored source `Library` into the immutable parent. New cache and
workspace records carry explicit `library-only-v1` and `git-worktree-library-cow-v1` layout markers.
Pre-adoption Full-project caches must be prepared again, and pre-adoption Full-project workspaces are
rejected by repair and removal rather than being interpreted under the new layout.

HoneyBee returns the worktree path. The user enters that directory and launches Codex, Claude Code,
Unity, a shell, or any other tool directly. HoneyBee does not configure or launch those tools,
supervise them, coordinate agents, commit, merge, rebase, push, or create pull requests. Branches
remain in the common repository after Workspace removal.

## Consequences

- Workspace creation pays a normal Git checkout cost, but it is the faster measured path for GNF_.
- Eight GNF_ workspaces consumed 13.704 GiB in A versus 5.718 GiB in B; this capacity tradeoff is
  accepted in exchange for the simpler boundary and lower create time.
- A ready Library child allocated 29 MiB before Unity versus 589 MiB for the no-rewrite Full-project
  child. Host checkout files account for the rest of A's footprint.
- User-authored files and Git metadata no longer depend on VHDX recovery. Generated `Library` state
  remains disposable and repairable storage.
- The retained-attach stale-mount ordering defect is fixed in pinned `unity-workspace-storage`
  revision `68e05e0`. Reboot recovery is released as an explicit `workspace repair` operation after
  the real Windows gate below passed.
- ADR-030 Full-project creation is retired; its benchmark implementation remains evidence, not a
  supported product mode.

## Reboot repair release gate

The previously pinned storage revision `e69fb8a0c55c91dee25274b3f40110b57fb538c4` had this call order
in `workspace.Broker.attachRetained`:

1. `validateWorkspaceMount` rejects any existing `Library` mount path.
2. `native.AttachChild` is therefore not reached.
3. `native.AttachChild` is the code that calls `storage.PrepareDetachedStaleMount`, which verifies the
   expected Child identity, expected volume GUID, and detached state before removing the stale mount.

After a real reboot, the expected stale directory-mount reparse point can still exist. The generic
precondition rejects it before the identity-aware cleanup can decide whether it is safe. HoneyBee
must not work around this by blindly unlinking or recursively deleting `Library`.

Pinned revision `68e05e0bf0e43b3c4c81cddf763012021cb80a4d` splits Workspace-container
validation from new-mount-leaf validation. Retained attach keeps root containment checks but defers
an existing mount leaf to `PrepareDetachedStaleMount`. Upstream tests prove that this path is reached
and that removal remains identity-bound and fail-closed. It also requires one child reserve before
publishing a prepared parent. HoneyBee updates all three pins together:

- `tools/workspace-storage-host/go.mod` and `go.sum`;
- `apps/desktop/scripts/prepare-tools.mjs` commit/version;
- `apps/desktop/resources/component-compatibility-v1.json` payload sizes and SHA-256 values.

Those pins and reproducible payload hashes are updated in the Beta 4 candidate. The final elevated
Windows gate was:

```text
create → modify/commit → shutdown/reboot → repair → Unity/import and authored-data verification → remove
```

It passes only if the repaired `Library` resolves to the expected retained volume, Git authored data
survives unchanged, the Workspace and retained Child have zero residuals after removal, and the Git
branch still exists.

The gate passed on Windows 11 x64 on 2026-09-04:

- the system boot identity changed from `system-process-01dd3a2dd52e448f` to
  `system-process-01dd3c619404abcb`;
- pre-repair `workspace status` reported `repair-required`, and `workspace repair` returned `ready`
  in 4,908 ms;
- the repaired junction resolved to the retained volume GUID recorded by the lease, while the Git
  HEAD `7ce42af58c65487d0892025b45a2ea944c672e52` and all bounded marker hashes were unchanged;
- Unity 6000.3.8f1 opened the repaired Workspace in batch mode and exited 0 without compiler-error
  signatures, leaving Git clean;
- removal completed in 2,620 ms, an identical retry completed from the durable receipt in 143 ms,
  and the disposable worktree, mount shell, child VHDX, lease, and retained record were absent;
- the branch still pointed to the same HEAD, while the unrelated pre-existing retained Workspace
  remained present and pending/quarantine counts stayed at zero.

The lease journal's `bootSessionId` remains acquisition provenance and is not rewritten by
`attach-retained`; current readiness is established by successful identity-checked attachment and
the broker's current status boot identity.
