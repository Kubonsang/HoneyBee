import { desktopApi } from "../desktop-api.js";
import {
  ArrowClockwise,
  CaretRight,
  FolderSimple,
  GearSix,
  GitBranch,
  Plus,
  Trash,
  Wrench,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { DesktopProjectV2, DesktopWorkspaceV2 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";
import { WorkspaceActions } from "./WorkspaceActions.js";
import { WorkspaceTerminal } from "./WorkspaceTerminal.js";
import {
  canRemoveWorkspace,
  workspaceStateKey,
  type RefreshStatus,
} from "../workspace-feedback.js";
import { useTerminalStore } from "../terminal-store.js";
import { ChangesReview } from "./ChangesReview.js";

export function WorkspaceWorkbench({
  project,
  workspaces,
  workspaceId,
  setWorkspaceId,
  busy,
  onCreate,
  onSwitchProject,
  onSettings,
  onRefresh,
  refreshStatus,
  run,
  t,
}: {
  project: DesktopProjectV2;
  workspaces: readonly DesktopWorkspaceV2[];
  workspaceId: string | undefined;
  setWorkspaceId: (id: string) => void;
  busy: boolean;
  onCreate: () => void;
  onSwitchProject: () => void;
  onSettings: () => void;
  onRefresh: () => Promise<void>;
  refreshStatus: RefreshStatus;
  run: (operation: () => Promise<void>, label?: MessageKey) => void;
  t: (key: MessageKey) => string;
}) {
  const terminalStore = useTerminalStore();
  const workspace = workspaces.find((item) => item.workspaceId === workspaceId) ?? workspaces[0];
  const [tab, setTab] = useState<"changes" | "terminal">("changes");
  const [terminalRunning, setTerminalRunning] = useState(false);
  const changes = workspace?.git?.changes ?? [];
  useEffect(() => {
    setTab("changes");
  }, [workspace?.workspaceId]);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void desktopApi
        .listPtys()
        .then((sessions) => {
          if (active)
            setTerminalRunning(
              sessions.some(
                (session) =>
                  session.projectId === project.projectId &&
                  session.workspaceId === workspace?.workspaceId &&
                  session.state === "running",
              ),
            );
        })
        .catch(() => {
          if (active) setTerminalRunning(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project.projectId, workspace?.workspaceId]);

  const launch = (tool: "cmd" | "powershell" | "vscode" | "unity"): void => {
    if (workspace === undefined) return;
    run(
      async () => {
        await desktopApi.launchExternal({
          projectId: project.projectId,
          workspaceId: workspace.workspaceId,
          tool,
        });
      },
      tool === "unity"
        ? "openUnityWorkspace"
        : tool === "vscode"
          ? "openCode"
          : tool === "cmd"
            ? "openCmd"
            : "openPowerShell",
    );
  };

  return (
    <section className="workbench-screen" data-testid="workspace-workbench">
      <header className="workbench-header">
        <button className="breadcrumb-project" onClick={onSwitchProject}>
          {t("projects")}
        </button>
        <CaretRight size={15} />
        <strong>{project.label}</strong>
        <span className={`cache-dot ${project.cacheState}`} />{" "}
        <small>{project.cacheState === "ready" ? t("ready") : t("setupRequired")}</small>
        <div className="header-actions">
          <button className="icon-button" title={t("settings")} onClick={onSettings}>
            <GearSix size={19} />
          </button>
          <button className="secondary" disabled={busy} onClick={() => run(onRefresh, "refresh")}>
            <ArrowClockwise size={18} />
            {t("refresh")}
          </button>
          <button
            className="primary"
            data-testid="new-workspace"
            disabled={busy || project.cacheState !== "ready"}
            onClick={onCreate}
          >
            <Plus size={18} weight="bold" />
            {t("newWorkspace")}
          </button>
        </div>
      </header>
      <div
        className={refreshStatus.failed ? "refresh-status stale" : "refresh-status"}
        role="status"
      >
        {refreshStatus.failed && <span>{t("refreshFailed")} </span>}
        {refreshStatus.updatedAt === undefined
          ? refreshStatus.failed
            ? ""
            : t("checking")
          : `${t("lastUpdated")}: ${new Date(refreshStatus.updatedAt).toLocaleTimeString()}`}
      </div>
      <div className="workbench-main">
        <aside className="workspace-pane">
          <div className="pane-title">
            <span>{t("workspaces")}</span>
            <small>{workspaces.length}</small>
          </div>
          <div className="workspace-list">
            {workspaces.map((item) => (
              <button
                key={item.workspaceId}
                className={
                  item.workspaceId === workspace?.workspaceId
                    ? "workspace-row selected"
                    : "workspace-row"
                }
                onClick={() => setWorkspaceId(item.workspaceId)}
              >
                <FolderSimple size={24} weight="duotone" />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    <GitBranch size={12} />
                    {item.branch}
                  </small>
                </span>
                <span className="workspace-status">
                  <i className={`state-dot ${item.state}`} />
                  {item.state === "ready" && item.available && item.git?.dirty
                    ? `${t("ready")} · ${item.git.changes.length} ${t("files")}`
                    : t(workspaceStateKey(item))}
                </span>
              </button>
            ))}
          </div>
        </aside>
        <div className="workspace-content">
          {workspace === undefined ? (
            <div className="empty-state">
              <FolderSimple size={58} weight="duotone" />
              <h2>
                {t(
                  refreshStatus.failed
                    ? "gitUnknown"
                    : refreshStatus.updatedAt === undefined
                      ? "checking"
                      : "noWorkspaces",
                )}
              </h2>
              <p>{t("noWorkspacesHelp")}</p>
              <button className="primary" onClick={onCreate}>
                <Plus size={18} />
                {t("newWorkspace")}
              </button>
            </div>
          ) : (
            <>
              <div className="workspace-overview">
                <div className="workspace-summary">
                  <div className="workspace-name">
                    <FolderSimple size={30} weight="duotone" />
                    <div>
                      <h1>{workspace.name}</h1>
                      <p>{workspace.workspacePath}</p>
                    </div>
                    <span className={`large-state ${workspace.state}`}>
                      {workspace.state === "ready" && workspace.available
                        ? t("ready")
                        : t(workspaceStateKey(workspace))}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>{t("branch")}</dt>
                      <dd>{workspace.branch}</dd>
                    </div>
                    <div>
                      <dt>{t("head")}</dt>
                      <dd className="mono">
                        {workspace.git?.head.slice(0, 10) ?? t("gitUnknown")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("git")}</dt>
                      <dd className={workspace.git === null || workspace.git.dirty ? "" : "good"}>
                        {workspace.git === null
                          ? t("gitUnknown")
                          : workspace.git.dirty
                            ? t("dirty")
                            : t("clean")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("changes")}</dt>
                      <dd>
                        {workspace.git === null
                          ? t("gitUnknown")
                          : `${workspace.git.changes.length} ${t("files")}`}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("library")}</dt>
                      <dd className={workspace.libraryConnected ? "good" : "bad"}>
                        {workspace.libraryConnected
                          ? t("connectedLibrary")
                          : t("disconnectedLibrary")}
                      </dd>
                    </div>
                    <div className="wide">
                      <dt>{t("path")}</dt>
                      <dd className="mono">{workspace.workspacePath}</dd>
                    </div>
                  </dl>
                  <div className="lifecycle-actions">
                    {(workspace.state === "repair-required" ||
                      (workspace.state === "ready" && !workspace.available)) && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await desktopApi.repairWorkspace({
                              projectId: project.projectId,
                              workspaceId: workspace.workspaceId,
                            });
                            await onRefresh();
                          }, "repair")
                        }
                      >
                        <Wrench size={17} />
                        {t("repair")}
                      </button>
                    )}
                    <button
                      className={
                        workspace.state === "cleanup-pending" ? "primary" : "danger-button"
                      }
                      disabled={busy || terminalRunning || !canRemoveWorkspace(workspace)}
                      title={
                        workspace.git === null && workspace.state !== "cleanup-pending"
                          ? t("gitUnknownHelp")
                          : workspace.git?.dirty
                            ? t("dirtyRemove")
                            : t("removeConfirm")
                      }
                      onClick={() => {
                        if (
                          window.confirm(
                            `${t("removeConfirm")}\n\n${workspace.name} (${workspace.branch})`,
                          )
                        )
                          run(async () => {
                            await desktopApi.removeWorkspace({
                              projectId: project.projectId,
                              workspaceId: workspace.workspaceId,
                            });
                            await terminalStore.close(project.projectId, workspace.workspaceId);
                            await onRefresh();
                          }, "remove");
                      }}
                    >
                      <Trash size={17} />
                      {workspace.state === "cleanup-pending" ? t("removeRetry") : t("remove")}
                    </button>
                    {terminalRunning && (
                      <small className="dirty-help">
                        {t("terminalRemoveHelp")}{" "}
                        <button onClick={() => setTab("terminal")}>{t("terminalGo")}</button>
                      </small>
                    )}
                    {workspace.git?.dirty === true && (
                      <small className="dirty-help">{t("dirtyRemove")}</small>
                    )}
                  </div>
                </div>
                <WorkspaceActions workspace={workspace} busy={busy} launch={launch} t={t} />
              </div>
              <nav className="detail-tabs">
                <button
                  className={tab === "changes" ? "active" : ""}
                  onClick={() => setTab("changes")}
                >
                  {t("changes")} <span>{workspace.git === null ? "?" : changes.length}</span>
                </button>
                <button
                  className={tab === "terminal" ? "active" : ""}
                  onClick={() => setTab("terminal")}
                >
                  {t("terminal")}
                </button>
              </nav>
              <div className="detail-panel">
                <div className="review-container" hidden={tab !== "changes"}>
                  <ChangesReview
                    key={`${project.projectId}/${workspace.workspaceId}`}
                    projectId={project.projectId}
                    workspace={workspace}
                    refreshedAt={refreshStatus.updatedAt}
                    t={t}
                  />
                </div>
                {tab === "terminal" && (
                  <WorkspaceTerminal projectId={project.projectId} workspace={workspace} t={t} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
