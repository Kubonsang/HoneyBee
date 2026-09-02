# ADR-028: Project-first Desktop Workbench and Git integration

## Status

Accepted for the Windows Desktop.

## Context

The prior Desktop exposed durable Runs but did not provide a useful project entry point, normal CLI
interaction, source browsing, or a visible integration model. Operators could not easily tell what an
Agent was doing or move several independently verified Works through a Git-like review flow.

## Decision

Desktop always starts in a Projects Hub. Main reads Unity Hub's bounded `projects-v1.json` registry
and combines valid Unity roots with HoneyBee profiles; it never edits Unity Hub state. Selecting a
managed project replaces the whole application shell. Runs are runtime-owned and continue when the
operator returns to the Hub.

The project shell provides Workbench, Work Map, Runs, Worktrees, Project Operations, and Settings.
Workbench file APIs accept only a profile ID and normalized relative path. Main resolves the profile
root, rejects traversal and symlink/reparse traversal, hides generated and Git directories, limits
directory/search results, and caps text previews at 1 MiB. The viewer is read-only.

Interactive terminals are separate from durable structured Agent sessions. Main owns all PTYs. A
renderer can request only the fixed project PowerShell or a connected Agent profile; main rechecks
Agent readiness and its trust receipt, resolves the project cwd, bounds input/output/resize values,
and closes every session at app exit. PTY output is process-local and is not evidence.

The Task Composer now has a plan-first operator gate. It shows Work nodes, Agent selection,
capabilities, parallelism, and the review/integration sink before execution. The live Work Map derives
its nodes from durable parent and child Runs; it does not become workflow authority.

Git integration happens after HoneyBee validation. The executor continues to use workspace-storage
isolation. For a clean named source branch, Desktop can materialize a pending verified text patch into
`honeybee/work/<run-id>`, commit it in a HoneyBee-owned worktree, and merge it only after explicit
operator approval into `honeybee/integration/<parent-run-id>`. A conflict remains in the integration
worktree and is shown as Integration Work. Source application is a separate approval and only uses
`git merge --ff-only`; source drift therefore fails without creating a source conflict. Successful
generated worktree folders are removed, while Work and integration branches are retained.

Patch materialization is fail-closed. It requires a clean source state and complete UTF-8 before/after
previews whose digests match. Binary, unavailable, or truncated content stays on the existing durable
patch-disposition path instead of being reconstructed from an incomplete view.

Desktop preferences use a separate strict atomic `preferences-v1.json`: density, terminal font size,
Explorer width, default Workbench resource, and reduced motion. They do not change execution policy.

## Consequences

The Desktop becomes a useful project control surface without moving scheduler, Run, cleanup, or
Artifact authority into React. Git branches provide human review and composition after validation,
but Agents do not execute inside those Git worktrees. Interactive terminal sessions are intentionally
non-durable. Repository dirtiness, detached source branches, incomplete patch previews, source drift,
and unsafe paths prevent automation rather than weakening the boundary.
