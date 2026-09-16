# Architecture decision index

## Active v0.7 decisions

- [ADR-001](ADR-001-windows-first.md): Windows-first platform boundary.
- [ADR-002](ADR-002-typescript-first.md): TypeScript product Core, with the narrow Go Windows storage
  host boundary.
- [ADR-031](ADR-031-git-worktree-library-only-cow.md): Git worktree plus Library-only CoW layout and
  completed reboot-repair release gate.
- [ADR-032](ADR-032-workspace-only-product-boundary.md): Workspace-only product and UI boundary.
- [ADR-033](ADR-033-desktop-onboarding-and-tool-launch.md): Desktop onboarding conveniences and
  explicit external-tool launch boundary.
- [ADR-034](ADR-034-exclusive-library-removal.md): exclusive Library-volume removal reservation and
  fail-closed behavior for externally launched tools.

ADR-029 remains useful context for user-owned Workspaces, but ADR-031 and ADR-032 are authoritative
where its clone, launch, or publish details differ. ADR-033 is authoritative for the narrow Desktop
clone and tool-launch conveniences retained in the Workspace-only product. ADR-034 is authoritative
for removal while external tools may still own handles in a Workspace Library.

ADR-035 defines the opt-in storage tool resolution boundary for future stable
installation paths. It preserves portable ZIP and registry behavior by default.
ADR-036 defines the native Launcher and CLI shim with a read-only active-version
contract and isolated Windows execution qualification.
ADR-037 adds complete installation assembly, a pinned private runtime and explicit,
backed-up project storage binding adoption.

- [ADR-038: Fresh application setup preview](ADR-038-fresh-setup-preview.md)

- [ADR-039: Service installation admission](ADR-039-service-install-admission.md)

- [ADR-040: Fresh service elevation](ADR-040-fresh-service-elevation.md)

- [ADR-041: Setup Git prerequisite](ADR-041-setup-git-prerequisite.md)
- [ADR-042: Release manifest and isolated update staging](ADR-042-release-manifest-and-staging.md)
- [ADR-043: Update package preparation](ADR-043-update-package-preparation.md)
- [ADR-044: Read-only Storage update preflight](ADR-044-storage-update-preflight.md)
- [ADR-045: Service identity evidence and component backup](ADR-045-service-evidence-backup.md)
- [ADR-046: Update service evidence integration](ADR-046-update-service-evidence-integration.md)
- [ADR-047: Pinned update plan and revalidation](ADR-047-pinned-update-plan.md)
- [ADR-048: Update lock and validation journal](ADR-048-update-lock-and-validation-journal.md)
- [ADR-049: App pointer commit and rollback](ADR-049-app-pointer-commit-and-rollback.md)
- [ADR-050: Verified version publication](ADR-050-immutable-version-publication.md)
- [ADR-051: Published update activation and recovery](ADR-051-published-update-activation.md)
- [ADR-052: Explicit-version Doctor health runner](ADR-052-version-doctor-health.md)
- [ADR-053: Windows Doctor process containment](ADR-053-doctor-process-containment.md)
- [ADR-054: Doctor activation integration](ADR-054-doctor-activation-integration.md)
- [ADR-055: Application activity gate](ADR-055-application-activity-gate.md)
- [ADR-056: Desktop and CLI activity participation](ADR-056-desktop-cli-activity-participation.md)
- [ADR-057: Packaged Desktop lifecycle qualification](ADR-057-packaged-desktop-lifecycle-qualification.md)
- [ADR-058: Desktop update lifecycle composition](ADR-058-desktop-update-lifecycle-composition.md)
- [ADR-059: Desktop session shutdown and restart readiness](ADR-059-desktop-session-transport.md)
- [ADR-060: VM Desktop update qualification](ADR-060-vm-desktop-update-qualification.md)
- [ADR-061: Interrupted Desktop update qualification](ADR-061-interrupted-desktop-update-qualification.md)
- [ADR-062: Launch-time recovery admission](ADR-062-launch-time-recovery-admission.md)
- [ADR-063: Pinned startup recovery runtime](ADR-063-pinned-startup-recovery-runtime.md)
- [ADR-064: Ordinary-launch recovery qualification](ADR-064-ordinary-launch-recovery-qualification.md)
- [ADR-065: Ordinary-launch recovery after reboot](ADR-065-reboot-ordinary-launch-recovery.md)
- [ADR-066: Assembly publication lock diagnosis](ADR-066-assembly-publication-lock-diagnosis.md)
- [ADR-067: Setup includes startup recovery runtime](ADR-067-setup-recovery-payload-publication.md)
- [ADR-068: Setup-installed automatic recovery qualification](ADR-068-setup-installed-recovery-qualification.md)
- [ADR-069: Setup-installed recovery after Windows restart](ADR-069-setup-installed-reboot-recovery.md)
- [ADR-070: Authenticated release discovery](ADR-070-authenticated-release-discovery.md)
- [ADR-071: Desktop authenticated update check](ADR-071-desktop-authenticated-update-check.md)
- [ADR-072: Desktop authenticated update download](ADR-072-desktop-authenticated-download.md)
- [ADR-073: Authenticated inactive update preparation](ADR-073-authenticated-inactive-preparation.md)
- [ADR-074: Independent preparation worker](ADR-074-independent-preparation-worker.md)
- [ADR-075: Desktop preparation handoff](ADR-075-desktop-preparation-handoff.md)
- [ADR-076: Continuing recovery approval](ADR-076-continuing-recovery-approval.md)
- [ADR-077: Desktop activation handoff](ADR-077-desktop-activation-handoff.md)
- [ADR-078: Update outcome in restarted Desktop](ADR-078-restarted-desktop-update-outcome.md)
- [ADR-079: Service migration transaction coordinator](ADR-079-service-migration-transaction.md)
- [ADR-080: Cold backup preparation](ADR-080-cold-backup-preparation.md)
- [ADR-081: Reserve volumes before stopping the service](ADR-081-reserved-volume-maintenance.md)
- [ADR-082: Workstreams 2–6 implementation, qualification deferred](ADR-082-remaining-workstreams-implementation.md)
- [ADR-083: Independent update integration while manual qualification is deferred](ADR-083-independent-update-integration.md)
- [ADR-084: Managed service pause and protected migration inputs](ADR-084-managed-service-maintenance.md)
- [ADR-085: Explicit unsigned beta distribution and protected release key](ADR-085-unsigned-beta-distribution.md)

## Historical decisions

ADR-003 through ADR-030 document earlier Extension, Agent session, orchestration, Unity executor,
Desktop control-plane, component manager, and Full-project CoW work. They are retained as decision
history and evidence, not as supported v0.7 product behavior. ADR-031 explicitly supersedes ADR-030.

Do not infer current features from a historical ADR. Start from ADR-031, ADR-032, and the current
README, then consult older decisions only for the rationale they preserve.
