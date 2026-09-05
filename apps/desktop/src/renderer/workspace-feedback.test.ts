import { expect, it } from "vitest";
import { DesktopApiError, type DesktopWorkspaceV2 } from "../shared/ipc.js";
import { canRemoveWorkspace, workspaceStateKey } from "./workspace-feedback.js";
import { canRetryManually, errorGuidance, operationError } from "./operation-errors.js";
const workspace: DesktopWorkspaceV2 = {
  projectId: "p",
  workspaceId: "w",
  name: "combat",
  workspacePath: "C:\\work",
  state: "ready",
  available: true,
  libraryConnected: true,
  branch: "work",
  baseCommit: "abc",
  git: null,
};
it("never labels unavailable Git as clean or permits normal removal", () => {
  expect(workspaceStateKey(workspace)).toBe("gitUnknown");
  expect(canRemoveWorkspace(workspace)).toBe(false);
  expect(workspaceStateKey({ ...workspace, state: "cleanup-pending" })).toBe("cleanupPending");
  expect(canRemoveWorkspace({ ...workspace, state: "cleanup-pending" })).toBe(true);
  const clean = { ...workspace, git: { branch: "work", head: "abc", dirty: false, changes: [] } };
  expect(canRemoveWorkspace(clean)).toBe(true);
  expect(canRemoveWorkspace({ ...clean, state: "provisioning" })).toBe(false);
  expect(canRemoveWorkspace({ ...clean, state: "removing" })).toBe(false);
  expect(canRemoveWorkspace({ ...clean, git: { ...clean.git, dirty: true } })).toBe(false);
  expect(workspaceStateKey({ ...clean, available: false })).toBe("repairRequired");
});
it("preserves storage capacity provenance and only offers safe manual in-use retries", () => {
  const error = operationError(
    new DesktopApiError({
      code: "storage.operation-failed",
      message: "capacity",
      upstreamCode: "storage-capacity-unavailable",
      remediation: ["Free space."],
    }),
  );
  expect(errorGuidance(error.code, error.upstreamCode)).toBe("capacityHelp");
  expect(error.code).toBe("storage.operation-failed");
  expect(canRetryManually("workspace.in-use")).toBe(true);
  expect(canRetryManually("workspace.dirty")).toBe(false);
  expect(errorGuidance("workspace.dirty")).toBe("dirtyRemove");
});
