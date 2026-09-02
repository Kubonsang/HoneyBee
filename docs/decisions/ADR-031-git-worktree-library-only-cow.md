# ADR-031: Git worktrees with Library-only CoW

## Status

Accepted for HoneyBee Workspace Core v0.7. Supersedes ADR-030. The user-directed tool boundary from
ADR-029 remains in force, but Git branches use ordinary shared-repository worktrees rather than
independent clones and publish steps.

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

Both retained children survived an actual reboot, but repair stopped at a shared broker ordering
defect: retained attach validates that the old mount path is absent before the native attach path can
run its existing detached-stale-mount cleanup. This is a broker limitation, not evidence that B won
or lost relative repair time.

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

HoneyBee may launch Codex, Claude Code, Unity, or a shell in the worktree. It does not supervise those
tools, coordinate agents, commit, merge, rebase, push, or create pull requests. Branches remain in
the common repository after Workspace removal.

## Consequences

- Workspace creation pays a normal Git checkout cost, but it is the faster measured path for GNF_.
- Eight GNF_ workspaces consumed 13.704 GiB in A versus 5.718 GiB in B; this capacity tradeoff is
  accepted in exchange for the simpler boundary and lower create time.
- A ready Library child allocated 29 MiB before Unity versus 589 MiB for the no-rewrite Full-project
  child. Host checkout files account for the rest of A's footprint.
- User-authored files and Git metadata no longer depend on VHDX recovery. Generated `Library` state
  remains disposable and repairable storage.
- The retained-attach stale-mount ordering defect remains a release blocker for automatic reboot
  repair and must be fixed in `unity-workspace-storage` independently of this layout decision.
- ADR-030 Full-project creation is retired; its benchmark implementation remains evidence, not a
  supported product mode.
