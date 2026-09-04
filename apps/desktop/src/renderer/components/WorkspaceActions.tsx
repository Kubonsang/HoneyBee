import { Code, MonitorPlay, TerminalWindow } from "@phosphor-icons/react";

import type { DesktopWorkspaceV2 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";

export function WorkspaceActions({
  workspace,
  busy,
  launch,
  t,
}: {
  workspace: DesktopWorkspaceV2;
  busy: boolean;
  launch: (tool: "cmd" | "powershell" | "vscode" | "unity") => void;
  t: (key: MessageKey) => string;
}) {
  const disabled = busy || workspace.state !== "ready" || !workspace.available;
  return (
    <div className="quick-actions">
      <p className="eyebrow">{t("actions")}</p>
      <button className="tool cmd" disabled={disabled} onClick={() => launch("cmd")}>
        <TerminalWindow size={22} />
        {t("openCmd")}
      </button>
      <button className="tool powershell" disabled={disabled} onClick={() => launch("powershell")}>
        <TerminalWindow size={22} weight="duotone" />
        {t("openPowerShell")}
      </button>
      <button className="tool code" disabled={disabled} onClick={() => launch("vscode")}>
        <Code size={22} />
        {t("openCode")}
      </button>
      <button className="tool unity" disabled={disabled} onClick={() => launch("unity")}>
        <MonitorPlay size={22} />
        {t("openUnityWorkspace")}
      </button>
    </div>
  );
}
