import type { DesktopWorkspaceV2 } from "../shared/ipc.js";
import type { MessageKey } from "./i18n.js";
export const workspaceStateKey = (workspace: DesktopWorkspaceV2): MessageKey => {
  switch (workspace.state) {
    case "provisioning":
      return "provisioning";
    case "repair-required":
      return "repairRequired";
    case "removing":
      return "removing";
    case "cleanup-pending":
      return "cleanupPending";
    case "ready":
      if (!workspace.available) return "repairRequired";
      return workspace.git === null ? "gitUnknown" : workspace.git.dirty ? "dirty" : "clean";
  }
};
export const canRemoveWorkspace = (workspace: DesktopWorkspaceV2): boolean =>
  workspace.state === "cleanup-pending" ||
  ((workspace.state === "ready" || workspace.state === "repair-required") &&
    workspace.git !== null &&
    !workspace.git.dirty);
export interface RefreshStatus {
  updatedAt?: number;
  failed: boolean;
}
