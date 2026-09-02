# ADR-032: Workspace-only product boundary

## Status

Accepted for HoneyBee v0.7.

## Context

Earlier HoneyBee releases accumulated two products in one repository: a Unity Workspace/storage
lifecycle and an Agent orchestration control plane. Their CLI commands, contracts, runtime journals,
approval flows, Desktop views, and native Agent host made the Workspace provider appear to own work
performed inside a Workspace.

ADR-031 established the useful durable boundary: authored data belongs to an ordinary Git worktree,
while HoneyBee storage owns only the generated Unity `Library`.

## Decision

HoneyBee is a Unity parallel Workspace provider. Its product responsibilities are limited to:

- registering Unity projects;
- preparing the Library parent cache;
- creating or attaching Git worktree Workspaces;
- reporting Workspace and Git status;
- repairing retained Library storage;
- safely removing the worktree and Library storage while preserving the branch.

The CLI contains only `project`, `cache`, and `workspace` commands. Stable JSON status DTOs are a
public automation surface, but storage paths and lease mechanics remain internal.

Desktop is a Workspace Workbench over the same Core: projects, Workspaces, Git status, changed files,
diff, and a user-operated PowerShell terminal. The terminal is a convenience rooted in the selected
Workspace, not an Agent session abstraction.

HoneyBee does not own Agent processes, task assignment, Run/DAG state, approval, compile/test
orchestration, patch publication, Git integration, or provider-specific Codex/Claude behavior.

## Breaking cleanup

v0.7 removes the orchestration and control-plane contract packages, legacy Run/Agent/Unity execution
modules, `workspace launch`, tool profiles, the native Agent host, orchestration examples and dogfood
executables, and the related Desktop screens and IPC. Compatibility adapters are not retained.

Historical ADRs, validation reports, benchmark inputs, raw results, and decision evidence remain in
the repository and are labeled historical. Git history remains the archive for removed executable
implementations.

## Consequences

- Users choose and operate tools after Workspace creation.
- CLI, Core, and Desktop share one lifecycle model and one registry.
- The package graph is `CLI/Desktop → Core → Git + storage component`; no orchestration contracts sit
  between them.
- Breaking removal is preferable to permanently maintaining two product identities.
- Storage safety, atomic registry updates, cleanup retry semantics, and branch preservation remain
  release requirements.
