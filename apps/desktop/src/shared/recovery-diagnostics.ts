import type { DesktopAppInfoV1, DesktopRecoveryOperationV2 } from "./ipc.js";

const checkCodes = new Set([
  "system.windows",
  "runtime.node",
  "git.executable",
  "registry.read",
  "storage.command",
  "storage.control-command",
  "storage.package-integrity",
  "storage.service",
  "storage.install-receipt",
  "storage.component-version",
  "storage.workspace-root",
  "storage.status",
  "projects.registered",
]);
export const recoveryErrorCodes = new Set([
  "recovery.cancelled",
  "recovery.download-failed",
  "recovery.download-interrupted",
  "recovery.records-unavailable",
  "recovery.use-app-update",
  "recovery.prepare-failed",
  "recovery.approval-step",
  "recovery.setup-running",
  "recovery.completed",
  "recovery.setup-incomplete",
  "recovery.rolled-back",
  "recovery.verification-required",
  "recovery.source-changed",
  "recovery.identity-unverified",
  "recovery.release-unavailable",
  "recovery.operation-active",
  "recovery.application-update-failed",
]);
const productVersion = (value: string | null) =>
  value !== null && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(value) && value.length <= 80
    ? value
    : null;
const storageVersion = (value: string | null) =>
  value !== null && /^\d+\.\d+\.\d+\+[a-f0-9]{12}\.hb\d+$/u.test(value) && value.length <= 80
    ? value
    : null;
const timestamp = (value: string | null) =>
  value !== null && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Explicit projection, never recursive serialization/redaction of arbitrary diagnostics. */
export function recoveryDiagnostics<
  T extends { readonly checks: readonly { code: string; status: "pass" | "warning" | "fail" }[] },
>(info: DesktopAppInfoV1, doctor: T, operation: DesktopRecoveryOperationV2) {
  return {
    schemaVersion: 1,
    application: {
      version: productVersion(info.applicationVersion),
      installation: info.installation,
      installedStorage: storageVersion(info.installedStorageVersion),
      requiredStorage: storageVersion(info.requiredStorageVersion),
    },
    checks: doctor.checks
      .filter((item) => checkCodes.has(item.code))
      .map(({ code, status }) => ({ code, status })),
    operation: {
      state: operation.state,
      route: operation.route,
      version: productVersion(operation.version),
      startedAt: timestamp(operation.startedAt),
      lastProgressAt: timestamp(operation.lastProgressAt),
      code:
        operation.code !== null && recoveryErrorCodes.has(operation.code) ? operation.code : null,
      preservation: operation.preservation,
    },
  };
}
