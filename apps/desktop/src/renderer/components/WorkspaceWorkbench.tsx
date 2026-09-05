import { desktopApi } from "../desktop-api.js";
import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  FolderSimple,
  GearSix,
  GitBranch,
  Plus,
  Trash,
  Wrench,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseGitStatusLine } from "@honeybee/core/git-status";

import type { DesktopGitDiffV1, DesktopProjectV2, DesktopWorkspaceV2 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";
import { WorkspaceActions } from "./WorkspaceActions.js";
import { WorkspaceTerminal } from "./WorkspaceTerminal.js";
import {
  canRemoveWorkspace,
  workspaceStateKey,
  type RefreshStatus,
} from "../workspace-feedback.js";
import { operationError, errorGuidance, type OperationError } from "../operation-errors.js";
import { useTerminalStore } from "../terminal-store.js";
import { LatestRequest } from "../latest-request.js";

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
  const [tab, setTab] = useState<"changes" | "diff" | "terminal">("changes");
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<OperationError>();
  const [diff, setDiff] = useState<DesktopGitDiffV1>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [untrackedSelected, setUntrackedSelected] = useState(false);
  const requests = useRef(new LatestRequest());
  const changes = useMemo(() => workspace?.git?.changes ?? [], [workspace]);
  const parsedChanges = useMemo(() => changes.map(parseGitStatusLine), [changes]);
  useEffect(() => {
    const current = requests.current;
    current.invalidate();
    setDiff(undefined);
    setSelectedPath(undefined);
    setTab("changes");
    return () => current.invalidate();
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

  const loadDiff = (requestedPath?: string): void => {
    if (workspace === undefined || workspace.git === null) return;
    const isCurrent = requests.current.begin();
    const untracked = parsedChanges.some((item) => item.path === requestedPath && item.untracked);
    setUntrackedSelected(untracked);
    setDiff(undefined);
    setSelectedPath(requestedPath);
    setTab("diff");
    setDiffError(undefined);
    setDiffLoading(!untracked);
    if (untracked) return;
    void (async () => {
      try {
        const result = await desktopApi.gitDiff({
          projectId: project.projectId,
          workspaceId: workspace.workspaceId,
          ...(requestedPath === undefined ? {} : { path: requestedPath }),
        });
        if (isCurrent()) setDiff(result);
      } catch (error) {
        if (isCurrent()) setDiffError(operationError(error));
      } finally {
        if (isCurrent()) setDiffLoading(false);
      }
    })();
  };
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
                  {item.state === "ready" && item.git?.dirty
                    ? `${item.git.changes.length} ${t("files")}`
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
                      {workspace.state === "ready" ? t("ready") : t(workspaceStateKey(workspace))}
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
                      <dd
                        className={
                          workspace.git === null ? "" : workspace.git.dirty ? "bad" : "good"
                        }
                      >
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
                  className={tab === "diff" ? "active" : ""}
                  disabled={workspace.git === null}
                  onClick={() => loadDiff(selectedPath)}
                >
                  {t("diff")}
                </button>
                <button
                  className={tab === "terminal" ? "active" : ""}
                  onClick={() => setTab("terminal")}
                >
                  {t("terminal")}
                </button>
              </nav>
              <div className="detail-panel">
                {tab === "terminal" ? (
                  <WorkspaceTerminal projectId={project.projectId} workspace={workspace} t={t} />
                ) : tab === "diff" ? (
                  <section className="diff-panel">
                    {diffError !== undefined && (
                      <div className="diff-error" role="alert">
                        <p>{t(errorGuidance(diffError.code, diffError.upstreamCode))}</p>
                        <details>
                          <summary>{t("diagnosticDetails")}</summary>
                          <code>{diffError.code}</code>
                          <p>{diffError.message}</p>
                        </details>
                        <button onClick={() => loadDiff(selectedPath)}>{t("retry")}</button>
                      </div>
                    )}
                    <pre className="diff-view">
                      {diffLoading
                        ? t("diffLoading")
                        : diffError !== undefined
                          ? ""
                          : workspace.git === null
                            ? t("gitUnknown")
                            : untrackedSelected
                              ? t("untrackedDiff")
                              : diff?.content ||
                                (diff !== undefined
                                  ? t("noTrackedDiff")
                                  : changes.length === 0
                                    ? t("clean")
                                    : t("selectFile"))}
                      {diff?.truncated ? `\n\n${t("diffTruncated")}` : ""}
                      {selectedPath === undefined && parsedChanges.some((item) => item.untracked)
                        ? `\n\n${t("untrackedDiff")}`
                        : ""}
                    </pre>
                  </section>
                ) : (
                  <div className="changed-files">
                    <button
                      className={selectedPath === undefined ? "selected" : ""}
                      disabled={workspace.git === null}
                      onClick={() => loadDiff()}
                    >
                      <CheckCircle size={17} />
                      {t("allChanges")}
                    </button>
                    {parsedChanges.map((change) => {
                      const file = change.path;
                      return (
                        <button key={file} onClick={() => loadDiff(file)}>
                          <code>{change.status}</code>
                          <span>{file}</span>
                        </button>
                      );
                    })}
                    {changes.length === 0 && (
                      <p>{workspace.git === null ? t("gitUnknown") : t("clean")}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
