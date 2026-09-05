import { desktopApi } from "../desktop-api.js";
import { useEffect, useRef, useState } from "react";
import type { DesktopPtySessionV1, DesktopWorkspaceV2 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";
import { useTerminalStore, type TerminalView } from "../terminal-store.js";

export function WorkspaceTerminal({
  projectId,
  workspace,
  t,
}: {
  projectId: string;
  workspace: DesktopWorkspaceV2;
  t: (key: MessageKey) => string;
}) {
  const store = useTerminalStore();
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TerminalView>({});
  const [closed, setClosed] = useState(false);
  const [sessions, setSessions] = useState<readonly DesktopPtySessionV1[]>([]);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (host.current === null || closed) return;
    return store.attach(projectId, workspace.workspaceId, host.current, setView);
  }, [store, projectId, workspace.workspaceId, closed]);
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void desktopApi
        .listPtys()
        .then((next) => {
          if (active) setSessions(next);
        })
        .catch((error: unknown) => {
          if (active) setView({ error });
        });
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const close = async (): Promise<void> => {
    if (view.session?.state === "running" && !window.confirm(t("terminalCloseConfirm"))) return;
    setClosing(true);
    try {
      await store.close(projectId, workspace.workspaceId);
      setClosed(true);
      setView({});
    } catch (error) {
      setView({ error });
    } finally {
      setClosing(false);
    }
  };
  return (
    <section className="terminal-panel">
      <div className="terminal-toolbar">
        <span>
          {view.session?.state === "exited"
            ? `${t("terminalExited")} (${view.session.exitCode ?? ""})`
            : t("terminal")}
        </span>
        {closed ? (
          <button
            disabled={!workspace.available || workspace.state !== "ready"}
            onClick={() => setClosed(false)}
          >
            {t("terminalOpen")}
          </button>
        ) : (
          <button
            disabled={closing || (view.session === undefined && view.error === undefined)}
            onClick={() => void close()}
          >
            {t("terminalClose")}
          </button>
        )}
      </div>
      {view.error !== undefined && (
        <p className="terminal-error">
          {view.error instanceof Error ? view.error.message : String(view.error)}
        </p>
      )}
      <div className="terminal-mount" ref={host} />
      <details className="terminal-sessions">
        <summary>
          {t("terminalSessions")} ({sessions.length}/16)
        </summary>
        <ul>
          {sessions
            .filter(
              (session) =>
                session.projectId !== projectId || session.workspaceId !== workspace.workspaceId,
            )
            .map((session) => (
              <li key={session.sessionId}>
                <span>{session.cwd}</span>
                <button
                  disabled={closing}
                  onClick={() => {
                    if (
                      session.state === "running" &&
                      !window.confirm(`${t("terminalCloseConfirm")}\n${session.cwd}`)
                    )
                      return;
                    setClosing(true);
                    void store
                      .close(session.projectId, session.workspaceId)
                      .then(() =>
                        setSessions((current) =>
                          current.filter((item) => item.sessionId !== session.sessionId),
                        ),
                      )
                      .catch((error: unknown) => setView({ error }))
                      .finally(() => setClosing(false));
                  }}
                >
                  {t("terminalClose")}
                </button>
              </li>
            ))}
        </ul>
      </details>
    </section>
  );
}
