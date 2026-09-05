import { desktopApi } from "./desktop-api.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { DesktopPtySessionV1 } from "../shared/ipc.js";

export interface TerminalView {
  session?: DesktopPtySessionV1;
  error?: unknown;
}
interface Entry {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  session: Promise<DesktopPtySessionV1>;
  cursor: number;
  ended: boolean;
  failed: boolean;
  detach?: () => void;
}

/** App-owned terminals retain input and scroll position across navigation. */
class TerminalStore {
  readonly entries = new Map<string, Entry>();
  attach(
    projectId: string,
    workspaceId: string,
    host: HTMLDivElement,
    update: (view: TerminalView) => void,
  ): () => void {
    const key = JSON.stringify([projectId, workspaceId]);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        scrollback: 1_000,
        fontFamily: "Cascadia Mono, Consolas, monospace",
        fontSize: 13,
        theme: { background: "#090b0d", foreground: "#e1e1e1", cursor: "#ffc52f" },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      const element = document.createElement("div");
      element.className = "terminal-host";
      host.replaceChildren(element);
      terminal.open(element);
      fit.fit();
      const session = desktopApi.createPty({
        projectId,
        workspaceId,
        columns: Math.max(20, Math.min(400, terminal.cols)),
        rows: Math.max(5, Math.min(200, terminal.rows)),
      });
      entry = { terminal, fit, element, session, cursor: 0, ended: false, failed: false };
      this.entries.set(key, entry);
    }
    const current = entry;
    host.replaceChildren(current.element);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | undefined;
    const fail = (error: unknown): void => {
      if (active) update({ error });
    };
    const resize = (): void => {
      if (!active || host.clientWidth === 0 || host.clientHeight === 0) return;
      current.fit.fit();
      if (sessionId !== undefined)
        void desktopApi
          .resizePty({
            sessionId,
            columns: Math.max(20, Math.min(400, current.terminal.cols)),
            rows: Math.max(5, Math.min(200, current.terminal.rows)),
          })
          .catch(fail);
    };
    const input = current.terminal.onData((data) => {
      if (sessionId !== undefined) void desktopApi.writePty({ sessionId, data }).catch(fail);
    });
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const poll = async (): Promise<void> => {
      if (!active || sessionId === undefined) return;
      try {
        const snapshot = await desktopApi.ptySnapshot({
          sessionId,
          afterCursor: current.cursor,
        });
        if (!active) return;
        if (snapshot.truncated) current.terminal.writeln("\r\n[earlier output truncated]");
        for (const chunk of snapshot.chunks) current.terminal.write(chunk.data);
        current.cursor = snapshot.cursor;
        update({ session: snapshot.session });
        if (snapshot.session.state === "exited") {
          if (!current.ended)
            current.terminal.writeln(`\r\n[PowerShell exited ${snapshot.session.exitCode ?? ""}]`);
          current.ended = true;
          return;
        }
        timer = setTimeout(() => void poll(), 100);
      } catch (error) {
        fail(error);
      }
    };
    void current.session
      .then((session) => {
        if (!active) return;
        sessionId = session.sessionId;
        update({ session });
        resize();
        current.terminal.focus();
        void poll();
      })
      .catch((error: unknown) => {
        current.failed = true;
        if (!active) {
          current.terminal.dispose();
          this.entries.delete(key);
        }
        fail(error);
      });
    const detach = (): void => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      current.element.remove();
      if (current.failed) {
        current.terminal.dispose();
        this.entries.delete(key);
      }
    };
    current.detach = detach;
    return detach;
  }
  async close(projectId: string, workspaceId: string): Promise<void> {
    const key = JSON.stringify([projectId, workspaceId]);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      const session = (await desktopApi.listPtys()).find(
        (item) => item.projectId === projectId && item.workspaceId === workspaceId,
      );
      if (session !== undefined) await desktopApi.closePty({ sessionId: session.sessionId });
      return;
    }
    const session = await entry.session.catch(() => undefined);
    if (session !== undefined) await desktopApi.closePty({ sessionId: session.sessionId });
    entry.detach?.();
    entry.terminal.dispose();
    this.entries.delete(key);
  }
}
const StoreContext = createContext<TerminalStore | undefined>(undefined);
export function TerminalProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TerminalStore());
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
export function useTerminalStore(): TerminalStore {
  const store = useContext(StoreContext);
  if (store === undefined) throw new Error("TerminalProvider is missing.");
  return store;
}
