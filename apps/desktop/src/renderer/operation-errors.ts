import { DesktopApiError } from "../shared/ipc.js";
import type { MessageKey } from "./i18n.js";

export interface OperationError {
  code: string;
  upstreamCode?: string;
  message: string;
  remediation: readonly string[];
}
export const operationError = (reason: unknown): OperationError =>
  reason instanceof DesktopApiError
    ? {
        code: reason.code,
        message: reason.message,
        remediation: reason.remediation,
        ...(reason.upstreamCode === undefined ? {} : { upstreamCode: reason.upstreamCode }),
      }
    : {
        code: "desktop.operation-failed",
        message: reason instanceof Error ? reason.message : String(reason),
        remediation: [],
      };
export const errorGuidance = (code: string, upstreamCode?: string): MessageKey => {
  if (upstreamCode === "storage-capacity-unavailable") return "capacityHelp";
  if (code === "desktop.terminal-running") return "terminalRemoveHelp";
  if (code === "desktop.terminal-limit") return "terminalLimitHelp";
  if (code === "workspace.in-use" || code === "storage.volume-in-use") return "inUseHelp";
  if (code.includes("dirty") || code.includes("untracked")) return "dirtyRemove";
  if (code === "workspace.repair-required") return "repairHelp";
  if (
    code.includes("capacity") ||
    code.includes("insufficient-space") ||
    code.includes("disk-full")
  )
    return "capacityHelp";
  if (code === "workspace.git-unavailable") return "gitUnknownHelp";
  return "operationHelp";
};
export const canRetryManually = (code: string): boolean =>
  code === "workspace.in-use" || code === "storage.volume-in-use";
