# ADR-029: User-owned CoW Workspaces and local Git publishing

## Status

Superseded by ADR-030. The independent clone and explicit publish design was never adopted as the
final Workspace Core boundary.

## Context

HoneyBee accumulated execution, scheduling, approval, Unity lifecycle, evidence, patch disposition,
and Git merge authority around its workspace-storage integration. This made an isolated project
directory inseparable from a HoneyBee Run. The intended product boundary is smaller: prepare cheap,
durable workspaces and let a human or an external orchestrating AI decide how work is performed.

## Decision

The primary project surface is a list of persistent user-owned Workspaces. Creation copies the
current project shell into a HoneyBee-owned durable directory and normalizes it to independent Git
metadata. A separate broker-owned shell acquires the differencing VHDX lease; its `Library` mount is
connected to the durable project by a directory junction. Provider recovery may discard that
generated cache, but it can never delete source work or Git commits. The lease is not coupled to an
Agent, terminal, or Unity process and is released only by explicit Workspace deletion during normal
operation.

If the source Unity project is the Git repository root, the Workspace begins at source `HEAD`.
Tracked and untracked source changes are overlaid and committed as an explicit
`HoneyBee base snapshot`. The user or their AI creates all later commits. Project subdirectories and
non-Git projects may still create Workspaces, but local branch publishing is blocked because their
commit tree does not match the source repository root.

HoneyBee may open a terminal, Unity, Explorer, or one directly configured Agent executable with the
Workspace as cwd. These are detached fire-and-forget launches. HoneyBee does not capture output,
mediate approvals, interpret command shims, or infer completion.

Publishing is the only normal operation that writes to the source repository. It requires a clean
Workspace with at least one commit after its base. Git objects are fetched into a temporary private
ref, the imported head is verified, and `refs/heads/honeybee/<work>` is created or fast-forwarded with
an expected-old-OID `update-ref`. Existing unrelated, checked-out, deleted-after-publish, or diverged
branches are never overwritten. HoneyBee does not merge, rebase, push a remote, or create a PR.

Deletion first proves the Workspace record and owner marker are beneath the configured storage root,
asks workspace-storage to release the VHDX lease, proves `Library` is no longer mounted, and only then
removes the shell. Published branches remain.

Legacy Runs remain readable as an archive. Work Map and automatic Work creation are removed from the
primary navigation. This decision supersedes ADR-028's Run-first worktree materialization and merge
flow. It narrows ADR-006: Git is used only for independent snapshot creation and explicit branch
publishing, while the storage provider remains authoritative for the writable Library lifecycle.

## Consequences

Users can run any tool directly and coordinate any number of Agents without HoneyBee becoming the
workflow authority. CoW savings remain concentrated in Unity's large generated Library while source
files and Git metadata are independently copied for safety. If provider recovery removes a stale
lease, the Workspace is shown as storage-offline while its source and commits remain available.
Workspaces consume capacity until users delete them, and the first implementation intentionally
requires a repository-root Unity project for branch publishing.
