import { createHash } from "node:crypto";
import { parseStorageServiceEvidence } from "./workspace-service-evidence.js";
import { inspectCompatibleStorage } from "./workspace-storage-adoption.js";
import { validateStorageTools } from "./workspace-tool-resolution.js";
import type { ResolvedStorageTools, WorkspaceStoragePort } from "./workspace-types.js";

export interface StorageUpdateRequirement {
  readonly componentVersion: string;
  readonly migration: {
    readonly kind: "none" | "service-replacement";
    readonly supportedSourceVersions: readonly string[];
  };
}
export interface StorageUpdatePlan {
  readonly schemaVersion: 1;
  readonly status: "app-only-candidate" | "migration-required" | "blocked";
  readonly reason: string;
  readonly activationAllowed: false;
  readonly elevation: "none" | "service-operation-only";
  readonly sourceComponentVersion?: string;
  readonly targetComponentVersion: string;
  readonly parentCount?: number;
  readonly sourceEvidenceSha256?: string;
  readonly steps: readonly string[];
  readonly remainingGates: readonly string[];
}

/** Read-only advisory plan. No target tool execution, installation, Repair or workspace deletion. */
export const planStorageUpdate = async (
  storage: WorkspaceStoragePort,
  tools: ResolvedStorageTools,
  target: StorageUpdateRequirement,
): Promise<StorageUpdatePlan> => {
  // Snapshot primitive fields before probes; callers cannot redirect the plan mid-flight.
  const current = { ...tools };
  const requirement = {
    componentVersion: target.componentVersion,
    kind: target.migration.kind,
    sources: [...target.migration.supportedSourceVersions],
  };
  const base = {
    schemaVersion: 1 as const,
    activationAllowed: false as const,
    targetComponentVersion: requirement.componentVersion,
    ...(current.expectedComponentVersion
      ? { sourceComponentVersion: current.expectedComponentVersion }
      : {}),
  };
  const blocked = (reason: string): StorageUpdatePlan => ({
    ...base,
    status: "blocked",
    reason,
    elevation: "none",
    steps: [],
    remainingGates: ["resolve-source-health"],
  });
  if (
    current.provenance !== "managed" ||
    !current.expectedComponentVersion ||
    !current.expectedClientSha256 ||
    !current.expectedControlSha256
  )
    return blocked("managed-source-required");
  if (
    !requirement.componentVersion ||
    !["none", "service-replacement"].includes(requirement.kind) ||
    !requirement.sources.includes(current.expectedComponentVersion)
  )
    return blocked("unsupported-storage-transition");
  if (
    requirement.kind === "none" &&
    requirement.componentVersion !== current.expectedComponentVersion
  )
    return blocked("migration-declaration-required");
  try {
    await validateStorageTools(current);
    if (!storage.serviceEvidence) return blocked("source-service-evidence-unavailable");
    const before = parseStorageServiceEvidence(await storage.serviceEvidence(current));
    if (
      before.receipt.componentVersion !== current.expectedComponentVersion ||
      before.executableSha256 !== current.expectedControlSha256
    )
      return blocked("source-service-identity-mismatch");
    const observation = await inspectCompatibleStorage(storage, current);
    if (
      observation.diagnostic.workspaceRoot?.toLowerCase() !==
      before.receipt.workspaceRoot.toLowerCase()
    )
      return blocked("source-workspace-root-mismatch");
    const after = parseStorageServiceEvidence(await storage.serviceEvidence(current));
    const canonical = JSON.stringify(before);
    if (JSON.stringify(after) !== canonical)
      return blocked("source-service-changed-during-preflight");
    const sourceEvidenceSha256 = createHash("sha256").update(canonical).digest("hex");
    const migration = requirement.kind === "service-replacement";
    return {
      ...base,
      status: migration ? "migration-required" : "app-only-candidate",
      reason: migration
        ? "recoverable-service-migrator-not-implemented"
        : "source-compatible-at-observation",
      elevation: migration ? "service-operation-only" : "none",
      parentCount: observation.status.parentCount,
      sourceEvidenceSha256,
      steps: migration
        ? [
            "quiesce-operations",
            "capture-service-and-workspace-backup",
            "migrate-service",
            "validate-service",
            "validate-target-doctor",
            "commit-active-version",
            "restart-desktop",
          ]
        : [
            "quiesce-operations",
            "recheck-service-compatibility",
            "validate-target-doctor",
            "commit-active-version",
            "restart-desktop",
          ],
      remainingGates: [
        "authenticate-release",
        "verify-prepared-inventory",
        "recheck-scm-and-receipt-under-lock",
        "validate-project-bindings",
        "acquire-update-and-operation-locks",
        ...(migration ? ["qualified-service-backup-and-rollback"] : []),
        "recheck-live-source",
        "durable-activation-and-recovery",
      ],
    };
  } catch {
    return blocked("source-tools-or-service-not-ready");
  }
};
