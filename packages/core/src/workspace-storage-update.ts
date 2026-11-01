import { createHash } from "node:crypto";
import path from "node:path";
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
  readonly sourceRecovery?: "legacy-hb12-detached";
}

export const publishedLegacyHb12 = Object.freeze({
  componentVersion: "0.0.0+cfa606fd4143.hb12",
  executableSha256: "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3",
});

/** Read-only advisory plan. No target tool execution, installation, Repair or workspace deletion. */
export const planStorageUpdate = async (
  storage: WorkspaceStoragePort,
  tools: ResolvedStorageTools,
  target: StorageUpdateRequirement,
  options: Readonly<{
    sourceRecovery?: "legacy-hb12-detached";
    installationRoot?: string;
  }> = {},
): Promise<StorageUpdatePlan> => {
  // Snapshot primitive fields before probes; callers cannot redirect the plan mid-flight.
  const current = { ...tools };
  const recovery = options.sourceRecovery;
  const legacy = recovery === "legacy-hb12-detached";
  const recoveryRoot = options.installationRoot;
  const recoveryWorkspaceRoot =
    typeof recoveryRoot === "string" ? path.win32.join(recoveryRoot, "Workspaces") : undefined;
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
  if (recovery !== undefined && !legacy) return blocked("unsupported-source-recovery");
  if (
    legacy &&
    (typeof recoveryRoot !== "string" ||
      !/^[A-Za-z]:\\/u.test(recoveryRoot) ||
      path.win32.normalize(recoveryRoot) !== recoveryRoot)
  )
    return blocked("canonical-legacy-installation-root-required");
  if (
    current.provenance !== "managed" ||
    !current.expectedComponentVersion ||
    !current.expectedClientSha256 ||
    !current.expectedControlSha256
  )
    return blocked("managed-source-required");
  if (
    legacy &&
    (current.expectedComponentVersion !== "0.0.0+cfa606fd4143.hb13" ||
      requirement.kind !== "service-replacement" ||
      requirement.componentVersion === publishedLegacyHb12.componentVersion)
  )
    return blocked("unsupported-legacy-recovery-source");
  const admittedSourceVersion = legacy
    ? publishedLegacyHb12.componentVersion
    : current.expectedComponentVersion;
  if (
    !requirement.componentVersion ||
    !["none", "service-replacement"].includes(requirement.kind) ||
    !requirement.sources.includes(admittedSourceVersion)
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
      before.receipt.componentVersion !== admittedSourceVersion ||
      before.executableSha256 !==
        (legacy ? publishedLegacyHb12.executableSha256 : current.expectedControlSha256)
    )
      return blocked("source-service-identity-mismatch");
    if (
      legacy &&
      before.receipt.workspaceRoot.toLowerCase() !== recoveryWorkspaceRoot?.toLowerCase()
    )
      return blocked("source-workspace-root-mismatch");
    // Keep the selected source package's helper paths and payload hashes intact.
    // Recovery admits only the exact installed legacy broker; it does not relabel
    // or substitute the packaged hb13 control executable.
    const observation = await inspectCompatibleStorage(
      storage,
      legacy ? { ...current, expectedComponentVersion: admittedSourceVersion } : current,
    );
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
      ...(legacy
        ? { sourceComponentVersion: admittedSourceVersion, sourceRecovery: recovery }
        : {}),
      status: migration ? "migration-required" : "app-only-candidate",
      reason: legacy
        ? "legacy-detached-recovery-required"
        : migration
          ? "recoverable-service-migrator-not-implemented"
          : "source-compatible-at-observation",
      elevation: migration ? "service-operation-only" : "none",
      parentCount: observation.status.parentCount,
      sourceEvidenceSha256,
      steps: migration
        ? [
            "quiesce-operations",
            ...(legacy
              ? ["retain-and-detach-all-workspaces", "verify-detached-source-inventory"]
              : []),
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
        ...(legacy ? ["admit-legacy-detached-recovery"] : []),
        "recheck-live-source",
        "durable-activation-and-recovery",
      ],
    };
  } catch {
    return blocked("source-tools-or-service-not-ready");
  }
};
