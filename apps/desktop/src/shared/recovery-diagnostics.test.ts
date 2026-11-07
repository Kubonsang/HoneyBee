import { describe, expect, it } from "vitest";
import { recoveryDiagnostics } from "./recovery-diagnostics.js";
import type { DesktopRecoveryOperationV2 } from "./ipc.js";

const operation: DesktopRecoveryOperationV2 = {
  schemaVersion: 2,
  state: "Unresolved",
  jobId: null,
  route: "setup-repair",
  version: "0.1.0-beta.40",
  startedAt: null,
  lastProgressAt: null,
  received: null,
  total: null,
  code: "recovery.setup-incomplete",
  preservation: "unknown",
  userAction: "check-setup",
  canCancel: false,
};
describe("local recovery diagnostics", () => {
  it("exports allowlisted states without user paths, messages, project names or credentials", () => {
    const result = recoveryDiagnostics(
      {
        schemaVersion: 1,
        installation: "managed",
        applicationVersion: "0.1.0-beta.40",
        installedStorageVersion: "C:\\Users\\PrivateName",
        requiredStorageVersion: "0.0.0+cfa606fd4143.hb17",
      },
      {
        schemaVersion: 1,
        ready: false,
        summary: { pass: 0, warning: 0, fail: 2 },
        checks: [
          {
            code: "storage.install-receipt",
            status: "fail",
            message: "PrivateName token=secret",
            subject: "C:\\Users\\PrivateName",
            remediation: ["secret"],
          },
          { code: "project.PrivateProject", status: "fail", message: "private" },
        ],
      },
      operation,
    );
    const json = JSON.stringify(result);
    for (const forbidden of [
      "PrivateName",
      "PrivateProject",
      "secret",
      "subject",
      "remediation",
      "message",
      "Users",
    ])
      expect(json).not.toContain(forbidden);
    expect(result.application.installedStorage).toBeNull();
    expect(result.checks).toEqual([{ code: "storage.install-receipt", status: "fail" }]);
    expect(result.operation.preservation).toBe("unknown");
  });
  it("does not export unknown codes or version-shaped user text", () => {
    const result = recoveryDiagnostics(
      {
        schemaVersion: 1,
        installation: "portable",
        applicationVersion: "private-project",
        installedStorageVersion: null,
        requiredStorageVersion: null,
      },
      { schemaVersion: 1, ready: true, summary: { pass: 0, warning: 0, fail: 0 }, checks: [] },
      { ...operation, code: "recovery.private-project", version: "private-project" },
    );
    expect(result.application.version).toBeNull();
    expect(result.operation.code).toBeNull();
    expect(result.operation.version).toBeNull();
  });
});
