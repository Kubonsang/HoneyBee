import type { MessageKey } from "./i18n.js";

export const setupGuidance = (code: string): MessageKey => {
  if (code === "storage.service") return "setupServiceHelp";
  if (code === "storage.component-version") return "setupVersionHelp";
  if (code === "storage.install-receipt") return "setupReceiptHelp";
  if (code === "storage.workspace-root") return "setupAccessHelp";
  if (["storage.command", "storage.control-command", "storage.package-integrity"].includes(code))
    return "setupPackageHelp";
  if (code.startsWith("git.")) return "setupGitHelp";
  if (code.startsWith("system.") || code.startsWith("runtime.")) return "setupSystemHelp";
  return "setupDiagnosticHelp";
};
