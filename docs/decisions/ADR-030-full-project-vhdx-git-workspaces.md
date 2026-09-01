# ADR-030: Full-project VHDX Git Workspaces

## Status

Superseded by ADR-031 after the GNF_ decision benchmark.

## Context

HoneyBee had accumulated workflow scheduling, agent protocols, approvals, Run journals, patch
disposition, and Git integration authority. The desired core is smaller: create cheap isolated
Unity project directories and let a human, Codex, Claude Code, or another orchestrator decide what
happens inside them.

Git worktrees normally require an empty destination, while a differencing VHDX is already populated
from its parent. The installed workspace-storage broker also derives its mount as
`<broker-workspace>/Library`, although the filesystem stored in that volume is not restricted to
Unity Library content.

## Decision

HoneyBee stores the complete clean Git tree plus the source Unity `Library` in the parent VHDX. A
child VHDX is mounted at the broker-derived `Library` path, but that mount is treated as the root of
the complete Git working tree. A junction at the user-selected Workspace path exposes the mount
without leaking the broker's internal layout.

To register the populated volume as a real worktree, HoneyBee creates a temporary
`git worktree add --no-checkout`, moves its `.git` pointer into the mounted child, runs
`git worktree repair`, and resets only the new child to the selected branch. New and unclaimed
existing branches are supported. Source working-tree changes are never copied; only a selected
commit seeds the parent and branch.

The existing authenticated broker pipe already supports retained children. HoneyBee releases a new
child with retention and reattaches it, so broker recovery preserves the VHDX independently of the
short-lived CLI process. `workspace repair` restores the mount, junction, and Git registration.
Clean removal relocates `.git` to a temporary directory, unregisters the worktree, removes the
retained child, and always preserves the branch.

HoneyBee may start Codex, Claude, Unity, or a shell in a new terminal. It does not monitor those
processes and does not commit, merge, rebase, push, publish, create PRs, or coordinate agents.

## Consequences

- Tracked project files and Unity cache writes both use VHDX copy-on-write blocks.
- Commits are immediately visible as ordinary branches in the common repository; no publish step
  exists.
- Parent preparation requires an existing ignored Unity `Library` and a Git commit.
- Git submodules and nested repositories are rejected in v1.
- Workspace removal refuses tracked or untracked changes and never deletes a branch.
- Desktop v0.7 only points to the CLI; a later GUI must call the same Workspace Core API.
