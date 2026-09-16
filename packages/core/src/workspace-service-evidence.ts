import path from "node:path";
import { WorkspaceCoreError, type StorageServiceEvidenceV1 } from "./workspace-types.js";

/** Decode only the known native evidence contract; never coerce missing values to healthy defaults. */
export const parseStorageServiceEvidence = (value: unknown): StorageServiceEvidenceV1 => {
  const fail = (): never => {
    throw new WorkspaceCoreError(
      "storage.invalid-evidence",
      "Storage service evidence is incomplete or inconsistent.",
    );
  };
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail();
  const string = (v: unknown): string =>
    typeof v === "string" && v.length > 0 && v.length <= 32768 ? v : fail();
  const hash = (v: unknown): string =>
    typeof v === "string" && /^[a-f0-9]{64}$/u.test(v) ? v : fail();
  const localPath = (v: unknown): string => {
    const s = string(v);
    return /^[A-Za-z]:\\/u.test(s) && path.win32.normalize(s) === s ? s : fail();
  };
  const data = object(value),
    receipt = object(data.receipt),
    scm = object(data.scm);
  if (
    data.schemaVersion !== 1 ||
    data.recoveryReady !== false ||
    receipt.schemaVersion !== 2 ||
    receipt.serviceName !== "UnityWorkspaceStorage" ||
    scm.account !== "LocalSystem" ||
    scm.startType !== 2 ||
    scm.serviceType !== 16 ||
    scm.state !== "running"
  )
    fail();
  const executableSha256 = hash(data.executableSha256);
  if (hash(receipt.executableSha256) !== executableSha256) fail();
  return {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 2,
      serviceName: "UnityWorkspaceStorage",
      pipeName: string(receipt.pipeName),
      componentVersion: string(receipt.componentVersion),
      storeRoot: localPath(receipt.storeRoot),
      workspaceRoot: localPath(receipt.workspaceRoot),
      configPath: localPath(receipt.configPath),
      userSid: string(receipt.userSid),
      executable: localPath(receipt.executable),
      executableSha256,
    },
    receiptSha256: hash(data.receiptSha256),
    configSha256: hash(data.configSha256),
    executableSha256,
    scm: {
      command: string(scm.command),
      account: "LocalSystem",
      startType: 2,
      serviceType: 16,
      state: "running",
    },
    recoveryReady: false,
  };
};
