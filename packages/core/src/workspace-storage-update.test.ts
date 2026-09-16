import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseStorageServiceEvidence } from "./workspace-service-evidence.js";
import { planStorageUpdate } from "./workspace-storage-update.js";
import type {
  ResolvedStorageTools,
  StorageDiagnosticV1,
  WorkspaceStoragePort,
} from "./workspace-types.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-update-plan-"));
  roots.push(root);
  await mkdir(path.join(root, "tools"));
  const tools: ResolvedStorageTools = {
    provenance: "managed",
    clientCommand: path.join(root, "tools/client.exe"),
    controlCommand: path.join(root, "tools/control.exe"),
    expectedComponentVersion: "source.hb12",
    expectedClientSha256: hash("client"),
    expectedControlSha256: hash("control"),
  };
  await writeFile(tools.clientCommand, "client");
  await writeFile(tools.controlCommand, "control");
  const diagnostic: StorageDiagnosticV1 = {
    serviceExists: true,
    serviceState: "running",
    receiptExists: true,
    receiptValid: true,
    executableExists: true,
    executableDigestMatches: true,
    userMatches: true,
    workspaceRootAccessible: true,
    componentVersion: "source.hb12",
    workspaceRoot: "C:\\HoneyBee\\Workspaces",
  };
  const diagnose = vi.fn(async () => diagnostic);
  const status = vi.fn(async () => ({ parentCount: 3, manualRecoveryRequired: false }));
  const evidence = parseStorageServiceEvidence({
    schemaVersion: 1,
    recoveryReady: false,
    receiptSha256: hash("receipt"),
    configSha256: hash("config"),
    executableSha256: hash("control"),
    receipt: {
      schemaVersion: 2,
      serviceName: "UnityWorkspaceStorage",
      pipeName: "pipe",
      componentVersion: "source.hb12",
      storeRoot: "C:\\ProgramData\\UnityWorkspaceStorage",
      workspaceRoot: "C:\\HoneyBee\\Workspaces",
      configPath: "C:\\ProgramData\\UnityWorkspaceStorage\\broker-config.json",
      userSid: "S-1-5-21-1",
      executable:
        "C:\\ProgramData\\UnityWorkspaceStorage\\broker\\unity-workspace-storage-host.exe",
      executableSha256: hash("control"),
    },
    scm: {
      command: "pinned broker command",
      account: "LocalSystem",
      startType: 2,
      serviceType: 16,
      state: "running",
    },
  });
  const serviceEvidence = vi.fn(async () => evidence);
  const storage = { diagnose, status, serviceEvidence } as unknown as WorkspaceStoragePort;
  const target = {
    componentVersion: "source.hb12",
    migration: { kind: "none" as const, supportedSourceVersions: ["source.hb12"] },
  };
  return { tools, storage, diagnose, status, target, serviceEvidence, evidence };
};
it("plans app-only update without requiring empty workspaces or authorizing activation", async () => {
  const f = await fixture();
  const plan = await planStorageUpdate(f.storage, f.tools, f.target);
  expect(plan).toMatchObject({
    status: "app-only-candidate",
    parentCount: 3,
    elevation: "none",
    activationAllowed: false,
  });
  expect(f.diagnose).toHaveBeenCalledTimes(1);
  expect(f.status).toHaveBeenCalledTimes(1);
  expect(plan.remainingGates).toContain("recheck-scm-and-receipt-under-lock");
  expect(f.serviceEvidence).toHaveBeenCalledTimes(2);
  expect(plan.sourceEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
});
it.each([0, 4])("requires recoverable migration even with %i parents", async (parentCount) => {
  const f = await fixture();
  f.status.mockResolvedValue({ parentCount, manualRecoveryRequired: false });
  const plan = await planStorageUpdate(f.storage, f.tools, {
    componentVersion: "next.hb13",
    migration: { kind: "service-replacement", supportedSourceVersions: ["source.hb12"] },
  });
  expect(plan).toMatchObject({
    status: "migration-required",
    parentCount,
    elevation: "service-operation-only",
    activationAllowed: false,
  });
  expect(plan.remainingGates).toContain("qualified-service-backup-and-rollback");
});
it("honors explicit service replacement even for the same compatibility identifier", async () => {
  const f = await fixture();
  expect(
    (
      await planStorageUpdate(f.storage, f.tools, {
        ...f.target,
        migration: { ...f.target.migration, kind: "service-replacement" },
      })
    ).status,
  ).toBe("migration-required");
});
it.each([
  "serviceExists",
  "receiptExists",
  "receiptValid",
  "executableExists",
  "executableDigestMatches",
  "userMatches",
  "workspaceRootAccessible",
] as const)("blocks unhealthy source %s", async (field) => {
  const f = await fixture();
  const state = await f.diagnose();
  f.diagnose.mockResolvedValue({ ...state, [field]: false });
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
  expect(f.status).not.toHaveBeenCalled();
});
it.each([{ serviceState: "stopped" }, { componentVersion: "other.hb11" }])(
  "blocks mismatched source diagnostic %j",
  async (change) => {
    const f = await fixture();
    f.diagnose.mockResolvedValue({ ...(await f.diagnose()), ...change });
    expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
  },
);
it.each([
  { parentCount: 0, manualRecoveryRequired: true },
  { parentCount: -1, manualRecoveryRequired: false },
])("blocks unsafe storage status %j", async (status) => {
  const f = await fixture();
  f.status.mockResolvedValue(status);
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
});
it("blocks failed probes and damaged source tools", async () => {
  const f = await fixture();
  f.diagnose.mockRejectedValue(new Error("access denied"));
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
  f.diagnose.mockClear();
  await writeFile(f.tools.controlCommand, "tampered");
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
  expect(f.diagnose).not.toHaveBeenCalled();
});
it("blocks unsupported or undeclared migration without querying the service", async () => {
  const f = await fixture();
  for (const target of [
    { ...f.target, componentVersion: "next.hb13" },
    { ...f.target, migration: { ...f.target.migration, supportedSourceVersions: ["other"] } },
  ]) {
    expect((await planStorageUpdate(f.storage, f.tools, target)).status).toBe("blocked");
  }
  expect(f.diagnose).not.toHaveBeenCalled();
});
it("requires managed, digest-pinned source tools", async () => {
  const f = await fixture();
  expect(
    (await planStorageUpdate(f.storage, { ...f.tools, provenance: "legacy" }, f.target)).status,
  ).toBe("blocked");
  expect(f.diagnose).not.toHaveBeenCalled();
});

it("blocks old hosts without an evidence capability", async () => {
  const f = await fixture();
  const { serviceEvidence: _unused, ...legacy } = f.storage;
  expect((await planStorageUpdate(legacy, f.tools, f.target)).reason).toBe(
    "source-service-evidence-unavailable",
  );
  expect(f.diagnose).not.toHaveBeenCalled();
});
it("blocks unsupported evidence commands without diagnostic fallback", async () => {
  const f = await fixture();
  f.serviceEvidence.mockRejectedValue(new Error("unknown command"));
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).status).toBe("blocked");
  expect(f.diagnose).not.toHaveBeenCalled();
});
it("binds installed service binary to the pinned source control digest", async () => {
  const f = await fixture();
  const changed = {
    ...f.evidence,
    executableSha256: hash("other"),
    receipt: { ...f.evidence.receipt, executableSha256: hash("other") },
  };
  f.serviceEvidence.mockResolvedValue(changed);
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).reason).toBe(
    "source-service-identity-mismatch",
  );
});
it("blocks source changes between the two evidence observations", async () => {
  const f = await fixture();
  f.serviceEvidence
    .mockResolvedValueOnce(f.evidence)
    .mockResolvedValueOnce({ ...f.evidence, configSha256: hash("changed") });
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).reason).toBe(
    "source-service-changed-during-preflight",
  );
});
it("blocks a diagnostic workspace root that differs from its receipt", async () => {
  const f = await fixture();
  f.diagnose.mockResolvedValue({ ...(await f.diagnose()), workspaceRoot: "C:\\other" });
  expect((await planStorageUpdate(f.storage, f.tools, f.target)).reason).toBe(
    "source-workspace-root-mismatch",
  );
});
