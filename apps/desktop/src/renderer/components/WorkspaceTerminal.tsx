import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import type { DesktopWorkspaceV2 } from "../../shared/ipc.js";

export function WorkspaceTerminal({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace: DesktopWorkspaceV2;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (host.current === null || !workspace.available) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#090b0d", foreground: "#e1e1e1", cursor: "#ffc52f" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    let stopped = false;
    let sessionId: string | undefined;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const input = terminal.onData((data) => {
      if (sessionId !== undefined) void window.honeybee.writePty({ sessionId, data });
    });
    const resize = (): void => {
      fit.fit();
      if (sessionId !== undefined)
        void window.honeybee.resizePty({ sessionId, columns: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const poll = async (): Promise<void> => {
      if (stopped || sessionId === undefined) return;
      try {
        const snapshot = await window.honeybee.ptySnapshot({ sessionId, afterCursor: cursor });
        if (snapshot.truncated) terminal.writeln("\r\n[earlier output truncated]");
        for (const chunk of snapshot.chunks) terminal.write(chunk.data);
        cursor = snapshot.cursor;
        if (snapshot.session.state === "exited") {
          terminal.writeln(`\r\n[PowerShell exited ${snapshot.session.exitCode ?? ""}]`);
          return;
        }
        timer = setTimeout(() => void poll(), 100);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Terminal polling failed.");
      }
    };
    void window.honeybee
      .createPty({
        projectId,
        workspaceId: workspace.workspaceId,
        columns: terminal.cols,
        rows: terminal.rows,
      })
      .then((session) => {
        if (stopped) {
          void window.honeybee.closePty({ sessionId: session.sessionId });
          return;
        }
        sessionId = session.sessionId;
        terminal.focus();
        void poll();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not open PowerShell."),
      );
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
      if (sessionId !== undefined) void window.honeybee.closePty({ sessionId });
    };
  }, [projectId, workspace.available, workspace.workspaceId]);
  return (
    <section className="terminal-panel">
      {error !== undefined && <p className="inline-error">{error}</p>}
      <div className="terminal-host" ref={host} />
    </section>
  );
}
