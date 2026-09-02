import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { DesktopGitDiffV1, DesktopProjectV1, DesktopWorkspaceV1 } from "../shared/ipc.js";

const changedPath = (line: string): string => {
  const value = line.length > 3 ? line.slice(3) : line;
  const rename = value.lastIndexOf(" -> ");
  return rename < 0 ? value : value.slice(rename + 4);
};

function WorkspaceTerminal({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace: DesktopWorkspaceV1;
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
      theme: { background: "#0d1311", foreground: "#d7e4dc", cursor: "#f2b84b" },
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
      if (sessionId !== undefined) {
        void window.honeybee.resizePty({ sessionId, columns: terminal.cols, rows: terminal.rows });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const poll = async (): Promise<void> => {
      if (stopped || sessionId === undefined) return;
      try {
        const snapshot = await window.honeybee.ptySnapshot({ sessionId, afterCursor: cursor });
        if (snapshot.truncated) terminal.writeln("\r\n[earlier terminal output was truncated]");
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
      {!workspace.available && <p>Repair this Workspace before opening a shell.</p>}
      {error !== undefined && <p className="error">{error}</p>}
      <div className="terminal-host" ref={host} />
    </section>
  );
}

export function App() {
  const [projects, setProjects] = useState<readonly DesktopProjectV1[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<readonly DesktopWorkspaceV1[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState(false);
  const [diff, setDiff] = useState<DesktopGitDiffV1>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [tab, setTab] = useState<"changes" | "terminal">("changes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const project = projects.find((item) => item.projectId === projectId);
  const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
  const changes = useMemo(() => workspace?.git?.changes ?? [], [workspace]);

  const refreshProjects = async (): Promise<void> => {
    const next = await window.honeybee.projects();
    setProjects(next);
    setProjectId((current) => current ?? next[0]?.projectId);
  };

  const refreshWorkspaces = async (selectedProject = projectId): Promise<void> => {
    if (selectedProject === undefined) return;
    const next = await window.honeybee.workspaces({ projectId: selectedProject });
    setWorkspaces(next);
    setWorkspaceId((current) =>
      current !== undefined && next.some((item) => item.workspaceId === current)
        ? current
        : next[0]?.workspaceId,
    );
  };

  useEffect(() => {
    void refreshProjects().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not load projects."),
    );
  }, []);

  useEffect(() => {
    setDiff(undefined);
    setSelectedPath(undefined);
    void refreshWorkspaces(projectId).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not load Workspaces."),
    );
  }, [projectId]);

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createWorkspace = (): void => {
    if (projectId === undefined || name.trim() === "" || branch.trim() === "") return;
    void run(async () => {
      const created = await window.honeybee.createWorkspace({
        projectId,
        name: name.trim(),
        branch: branch.trim(),
        existingBranch,
      });
      setName("");
      setBranch("");
      await refreshWorkspaces(projectId);
      setWorkspaceId(created.workspaceId);
    });
  };

  const loadDiff = (path?: string): void => {
    if (projectId === undefined || workspace === undefined) return;
    setSelectedPath(path);
    void run(async () => {
      setDiff(
        await window.honeybee.gitDiff({
          projectId,
          workspaceId: workspace.workspaceId,
          ...(path === undefined ? {} : { path }),
        }),
      );
    });
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span>HONEYBEE 0.7</span>
          <h1>Workspace Workbench</h1>
        </div>
        <p>Git worktrees with Library-only CoW</p>
      </header>
      {error !== undefined && <div className="error-banner">{error}</div>}
      <div className="layout">
        <aside className="sidebar">
          <h2>Projects</h2>
          {projects.length === 0 ? (
            <div className="empty">
              <p>No registered projects.</p>
              <code>honeybee project init &lt;path&gt; --workspace-root &lt;path&gt;</code>
            </div>
          ) : (
            projects.map((item) => (
              <button
                className={item.projectId === projectId ? "selected" : ""}
                key={item.projectId}
                onClick={() => setProjectId(item.projectId)}
              >
                <strong>{item.label}</strong>
                <small>{item.cacheState} cache</small>
              </button>
            ))
          )}
          <h2>Workspaces</h2>
          {workspaces.map((item) => (
            <button
              className={item.workspaceId === workspaceId ? "selected" : ""}
              key={item.workspaceId}
              onClick={() => setWorkspaceId(item.workspaceId)}
            >
              <strong>{item.name}</strong>
              <small>{item.branch}</small>
            </button>
          ))}
        </aside>
        <section className="content">
          {project === undefined ? (
            <div className="welcome">
              <h2>Register a Unity project from the CLI</h2>
              <p>HoneyBee only owns Workspace and Library storage lifecycle.</p>
            </div>
          ) : (
            <>
              <div className="project-summary">
                <div>
                  <small>PROJECT</small>
                  <h2>{project.label}</h2>
                  <code>{project.unityProjectPath}</code>
                </div>
                <span className={`pill ${project.cacheState}`}>{project.cacheState} cache</span>
              </div>
              <div className="create-row">
                <input
                  aria-label="Workspace name"
                  placeholder="Workspace name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <input
                  aria-label="Branch"
                  placeholder="feature/branch"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={existingBranch}
                    onChange={(event) => setExistingBranch(event.target.checked)}
                  />
                  Attach existing
                </label>
                <button disabled={busy || project.cacheState !== "ready"} onClick={createWorkspace}>
                  Create
                </button>
              </div>
              {workspace === undefined ? (
                <div className="welcome">
                  <h2>No Workspaces yet</h2>
                  <p>Prepare the cache, then create one above.</p>
                </div>
              ) : (
                <>
                  <div className="workspace-header">
                    <div>
                      <small>{workspace.state.toUpperCase()}</small>
                      <h2>{workspace.name}</h2>
                      <code>{workspace.workspacePath}</code>
                    </div>
                    <div className="actions">
                      <button disabled={busy} onClick={() => void refreshWorkspaces()}>
                        Refresh
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await window.honeybee.repairWorkspace({
                              projectId: project.projectId,
                              workspaceId: workspace.workspaceId,
                            });
                            await refreshWorkspaces(project.projectId);
                          })
                        }
                      >
                        Repair
                      </button>
                      <button
                        className="danger"
                        disabled={busy || workspace.git?.dirty === true}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${workspace.name}? Its branch will be preserved.`,
                            )
                          )
                            void run(async () => {
                              await window.honeybee.removeWorkspace({
                                projectId: project.projectId,
                                workspaceId: workspace.workspaceId,
                              });
                              await refreshWorkspaces(project.projectId);
                            });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="metadata">
                    <span>
                      Branch <b>{workspace.branch}</b>
                    </span>
                    <span>
                      HEAD <b>{workspace.git?.head.slice(0, 10) ?? "unavailable"}</b>
                    </span>
                    <span>{workspace.git?.dirty ? "Dirty" : "Clean"}</span>
                  </div>
                  <nav className="tabs">
                    <button
                      className={tab === "changes" ? "active" : ""}
                      onClick={() => setTab("changes")}
                    >
                      Changed files ({changes.length})
                    </button>
                    <button
                      className={tab === "terminal" ? "active" : ""}
                      onClick={() => setTab("terminal")}
                    >
                      Terminal
                    </button>
                  </nav>
                  {tab === "terminal" ? (
                    <WorkspaceTerminal projectId={project.projectId} workspace={workspace} />
                  ) : (
                    <div className="changes-layout">
                      <aside className="changes-list">
                        <button
                          className={selectedPath === undefined ? "selected" : ""}
                          onClick={() => loadDiff()}
                        >
                          All changes
                        </button>
                        {changes.map((change) => {
                          const file = changedPath(change);
                          return (
                            <button
                              className={selectedPath === file ? "selected" : ""}
                              key={change}
                              onClick={() => loadDiff(file)}
                            >
                              <code>{change.slice(0, 2)}</code>
                              {file}
                            </button>
                          );
                        })}
                      </aside>
                      <pre className="diff-view">
                        {diff?.content ||
                          (changes.length === 0
                            ? "Working tree is clean."
                            : "Select a changed file to inspect its diff.")}
                        {diff?.truncated ? "\n\n[diff truncated at 1 MiB]" : ""}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
