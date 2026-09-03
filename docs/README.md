# Documentation map

## Current product documentation

- [Repository README](../README.md): v0.7 product, CLI, Desktop, and safety contract.
- [ADR-031](decisions/ADR-031-git-worktree-library-only-cow.md): Git worktree and Library-only CoW
  architecture, including the reboot-repair blocker.
- [ADR-032](decisions/ADR-032-workspace-only-product-boundary.md): Workspace-only responsibility
  boundary.
- [ADR-033](decisions/ADR-033-desktop-onboarding-and-tool-launch.md): Desktop project onboarding and
  user-triggered external tool boundary.
- [Windows Desktop Beta](operations/windows-desktop-beta.md): Workbench onboarding, setup, and
  Workspace operation guide.
- [v0.7 migration](migrations/v0.7-workspace-only.md): breaking cleanup, registry migration, tests,
  and rollback.

## Historical evidence

- [`decisions/`](decisions/README.md) retains all earlier ADRs and labels which decisions are active.
- `benchmarks/` retains experiment protocols, raw results, screenshots, and decisions. These files are
  not executable product modes.
- `validation/` retains earlier vertical-slice and Desktop validation reports. They describe retired
  product surfaces unless an active ADR explicitly carries a result forward.
- `architecture/initial-architecture.md` is the retired initial architecture.

Historical files are intentionally preserved. Do not update them to simulate current behavior; add a
new active decision or validation record instead.
