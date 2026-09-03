# Architecture decision index

## Active v0.7 decisions

- [ADR-001](ADR-001-windows-first.md): Windows-first platform boundary.
- [ADR-002](ADR-002-typescript-first.md): TypeScript product Core, with the narrow Go Windows storage
  host boundary.
- [ADR-031](ADR-031-git-worktree-library-only-cow.md): Git worktree plus Library-only CoW layout and
  reboot-repair release gate.
- [ADR-032](ADR-032-workspace-only-product-boundary.md): Workspace-only product and UI boundary.
- [ADR-033](ADR-033-desktop-onboarding-and-tool-launch.md): Desktop onboarding conveniences and
  explicit external-tool launch boundary.

ADR-029 remains useful context for user-owned Workspaces, but ADR-031 and ADR-032 are authoritative
where its clone, launch, or publish details differ. ADR-033 is authoritative for the narrow Desktop
clone and tool-launch conveniences retained in the Workspace-only product.

## Historical decisions

ADR-003 through ADR-030 document earlier Extension, Agent session, orchestration, Unity executor,
Desktop control-plane, component manager, and Full-project CoW work. They are retained as decision
history and evidence, not as supported v0.7 product behavior. ADR-031 explicitly supersedes ADR-030.

Do not infer current features from a historical ADR. Start from ADR-031, ADR-032, and the current
README, then consult older decisions only for the rationale they preserve.
