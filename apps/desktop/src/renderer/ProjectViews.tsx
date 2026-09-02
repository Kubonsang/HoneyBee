import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Circle,
  ClockCounterClockwise,
  Code,
  Cpu,
  GitBranch,
  GitCommit,
  GitMerge,
  HardDrives,
  FolderOpen,
  Plus,
  Pulse,
  Robot,
  SpinnerGap,
  Stethoscope,
  TerminalWindow,
  Trash,
  UploadSimple,
  Warning,
} from "@phosphor-icons/react";

import type { DoctorReportV1 } from "@honeybee/control-plane-contracts";

import type {
  DesktopAgentProfileV1,
  DesktopGitSnapshotV1,
  DesktopProjectProfile,
  DesktopRuntimeSnapshotV1,
  DesktopWorkspaceSnapshotV1,
} from "../shared/ipc.js";

interface ProjectViewProps {
  readonly profile: DesktopProjectProfile;
  readonly snapshot?: DesktopRuntimeSnapshotV1 | undefined;
  readonly doctor?: DoctorReportV1 | undefined;
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly onRunDoctor: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onNewWork: () => void;
  readonly onError?: ((message: string) => void) | undefined;
  readonly onNotice?: ((message: string) => void) | undefined;
}

const runTitle = (run: DesktopRuntimeSnapshotV1["runs"][number]): string =>
  run.workId === undefined ? run.mode.replaceAll("-", " ") : run.workId;

export function WorkMapView({ snapshot, onSelectRun, onNewWork }: ProjectViewProps) {
  const runs = snapshot?.runs ?? [];
  const active = runs.filter((run) => !run.terminal);
  return (
    <section className="project-surface work-map-view">
      <header className="project-view-heading">
        <div>
          <span className="eyebrow">ORCHESTRATION</span>
          <h1>Agent Work Map</h1>
          <p>Follow every durable Work from assignment through validation and review.</p>
        </div>
        <button className="primary" onClick={onNewWork}>
          <Pulse size={17} /> Plan new Work
        </button>
      </header>

      <div className="work-map-summary">
        <article>
          <SpinnerGap className={active.length > 0 ? "spin-icon" : ""} size={21} />
          <strong>{active.length}</strong>
          <span>Agent active</span>
        </article>
        <article>
          <ClockCounterClockwise size={21} />
          <strong>{runs.length}</strong>
          <span>Durable Runs</span>
        </article>
        <article>
          <GitMerge size={21} />
          <strong>0</strong>
          <span>Awaiting merge</span>
        </article>
      </div>

      {runs.length === 0 ? (
        <div className="map-empty-state">
          <GitBranch size={42} weight="duotone" />
          <h2>No Work has been planned yet</h2>
          <p>Create a goal, review the proposed Work cards, then approve execution.</p>
          <button className="primary" onClick={onNewWork}>
            Plan the first Work
          </button>
        </div>
      ) : (
        <div className="work-dag" aria-label="Agent Work dependency graph">
          <div className="work-card-map">
            {runs.map((run, index) => (
              <button
                key={run.runId}
                className="map-work-card"
                onClick={() => onSelectRun(run.runId)}
              >
                <span className={`map-status ${run.terminal ? "terminal" : "active"}`}>
                  {run.terminal ? (
                    <CheckCircle size={18} weight="fill" />
                  ) : (
                    <SpinnerGap className="spin-icon" size={18} />
                  )}
                </span>
                <small>WORK {index + 1}</small>
                <strong>{runTitle(run)}</strong>
                <span>{run.phase}</span>
                <footer>
                  <em>{run.assignedEditor ?? "Agent session"}</em>
                  <code>{run.runId.slice(0, 8)}</code>
                </footer>
              </button>
            ))}
          </div>
          <div className="dag-flow-arrow" aria-hidden="true">
            →
          </div>
          <article className="dag-integration-card">
            <GitMerge size={25} weight="duotone" />
            <strong>Review & integrate</strong>
            <small>Every Work remains approval-gated.</small>
          </article>
        </div>
      )}
    </section>
  );
}

const workspaceBytes = (value: number | undefined): string => {
  if (value === undefined) return "CoW allocation pending";
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB allocated`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB allocated`;
  return `${(value / 1024 ** 3).toFixed(2)} GB allocated`;
};

export function WorkspacesView({ profile }: ProjectViewProps) {
  return (
    <section className="project-surface workspaces-view">
      <header className="project-view-heading">
        <div>
          <span className="eyebrow">CLI-FIRST WORKSPACE CORE</span>
          <h1>CoW Workspaces</h1>
          <p>
            HoneyBee Desktop no longer creates, supervises, or publishes work. Use the CLI to make a
            Git worktree with a VHDX-backed Unity Library, then open Codex, Claude, Unity, or a
            shell.
          </p>
        </div>
      </header>
      <div className="map-empty-state">
        <TerminalWindow size={42} weight="duotone" />
        <h2>Workspace Core is CLI-first</h2>
        <p>{profile.projectPath}</p>
        <code>
          honeybee project init &quot;{profile.projectPath}&quot; --workspace-root
          &quot;D:\HoneyBee-Workspaces&quot;
        </code>
        <code>honeybee cache prepare</code>
        <code>honeybee workspace create tutorial --branch feature/tutorial</code>
        <code>honeybee workspace launch tutorial codex</code>
      </div>
    </section>
  );
}

export function LegacyManagedWorkspacesView({ profile, onError, onNotice }: ProjectViewProps) {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceSnapshotV1>();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string>();

  const refresh = async (): Promise<void> => {
    try {
      setSnapshot(
        await window.honeybee.workspaceSnapshot({ schemaVersion: 1, profileId: profile.profileId }),
      );
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Workspace inspection failed.");
    }
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (!stopped) await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [profile.profileId]);

  const createWorkspace = async (): Promise<void> => {
    if (label.trim().length === 0) return;
    setBusy("create");
    try {
      await window.honeybee.createWorkspace({
        schemaVersion: 1,
        profileId: profile.profileId,
        label: label.trim(),
      });
      setLabel("");
      await refresh();
      onNotice?.("CoW Workspace created. Open a tool and work directly inside it.");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Workspace creation failed.");
    } finally {
      setBusy(undefined);
    }
  };

  const openWorkspace = async (
    workspaceId: string,
    target: "terminal" | "unity" | "agent" | "explorer",
  ): Promise<void> => {
    setBusy(`${workspaceId}:${target}`);
    try {
      await window.honeybee.openWorkspace({
        schemaVersion: 1,
        profileId: profile.profileId,
        workspaceId,
        target,
      });
      onNotice?.(`Opened ${target}. HoneyBee will not supervise the process.`);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : `Could not open ${target}.`);
    } finally {
      setBusy(undefined);
    }
  };

  const publishWorkspace = async (workspaceId: string, branch: string): Promise<void> => {
    setBusy(`${workspaceId}:publish`);
    try {
      const receipt = await window.honeybee.publishWorkspace({
        schemaVersion: 1,
        profileId: profile.profileId,
        workspaceId,
        branch,
      });
      await refresh();
      onNotice?.(`Published ${receipt.branch} at ${receipt.commit.slice(0, 8)}.`);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Workspace publishing failed.");
    } finally {
      setBusy(undefined);
    }
  };

  const deleteWorkspace = async (workspaceId: string, workspaceLabel: string): Promise<void> => {
    if (
      !window.confirm(`Delete “${workspaceLabel}” and its CoW disk? Published branches remain.`)
    ) {
      return;
    }
    setBusy(`${workspaceId}:delete`);
    try {
      setSnapshot(
        await window.honeybee.deleteWorkspace({
          schemaVersion: 1,
          profileId: profile.profileId,
          workspaceId,
        }),
      );
      onNotice?.("Workspace and its CoW disk were released and deleted.");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Workspace deletion failed.");
    } finally {
      setBusy(undefined);
    }
  };

  const workspaces = snapshot?.workspaces ?? [];
  return (
    <section className="project-surface workspaces-view">
      <header className="project-view-heading">
        <div>
          <span className="eyebrow">ISOLATED PROJECT WORK</span>
          <h1>CoW Workspaces</h1>
          <p>Create a durable project directory, work with any tool, then publish its commits.</p>
        </div>
        <div className="workspace-create-form">
          <input
            value={label}
            maxLength={80}
            placeholder="Work name"
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createWorkspace();
            }}
          />
          <button
            className="primary"
            disabled={
              busy !== undefined || label.trim().length === 0 || snapshot?.supported === false
            }
            onClick={() => void createWorkspace()}
          >
            {busy === "create" ? (
              <SpinnerGap className="spin-icon" size={16} />
            ) : (
              <Plus size={16} />
            )}
            Create Workspace
          </button>
        </div>
      </header>
      {snapshot?.supported === false && <p className="worktree-message">{snapshot.message}</p>}
      <div className="workspace-list">
        {snapshot === undefined ? (
          <div className="map-empty-state compact">
            <SpinnerGap className="spin-icon" size={32} />
            <p>Reading Workspaces…</p>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="map-empty-state">
            <HardDrives size={42} weight="duotone" />
            <h2>No CoW Workspaces yet</h2>
            <p>Name one Work. HoneyBee prepares isolation, then gets out of your way.</p>
          </div>
        ) : (
          workspaces.map((workspace) => (
            <article
              className={`workspace-card state-${workspace.publishState}`}
              key={workspace.workspaceId}
            >
              <header>
                <span className="workspace-drive">
                  <HardDrives size={22} weight="duotone" />
                </span>
                <div>
                  <small>{workspace.publishState.replaceAll("-", " ").toUpperCase()}</small>
                  <strong>{workspace.label}</strong>
                  <code>{workspace.branch}</code>
                </div>
                <span className={`status-pill ${workspace.git.state === "clean" ? "ready" : ""}`}>
                  {workspace.git.state} · {workspace.git.aheadCommits} commit
                  {workspace.git.aheadCommits === 1 ? "" : "s"}
                </span>
              </header>
              <p title={workspace.workspacePath}>{workspace.workspacePath}</p>
              <div className="workspace-metadata">
                <span>{workspaceBytes(workspace.allocatedBytes)}</span>
                <span>Base {workspace.baseCommit.slice(0, 8)}</span>
                <span>{workspace.git.changedFiles} changed files</span>
                {workspace.publishedCommit !== undefined && (
                  <span>Published {workspace.publishedCommit.slice(0, 8)}</span>
                )}
              </div>
              {workspace.message !== undefined && (
                <p className="workspace-warning">
                  <Warning size={15} /> {workspace.message}
                </p>
              )}
              <footer className="workspace-actions">
                <button
                  className="secondary"
                  onClick={() => void openWorkspace(workspace.workspaceId, "terminal")}
                >
                  <TerminalWindow size={15} /> Terminal
                </button>
                <button
                  className="secondary"
                  onClick={() => void openWorkspace(workspace.workspaceId, "unity")}
                >
                  <Cpu size={15} /> Unity
                </button>
                <button
                  className="secondary"
                  onClick={() => void openWorkspace(workspace.workspaceId, "agent")}
                >
                  <Robot size={15} /> AI Tool
                </button>
                <button
                  className="secondary"
                  onClick={() => void openWorkspace(workspace.workspaceId, "explorer")}
                >
                  <FolderOpen size={15} /> Files
                </button>
                <button
                  className="primary"
                  disabled={
                    busy !== undefined ||
                    workspace.git.state !== "clean" ||
                    workspace.git.aheadCommits === 0 ||
                    workspace.publishState === "diverged" ||
                    workspace.publishState === "blocked"
                  }
                  onClick={() => void publishWorkspace(workspace.workspaceId, workspace.branch)}
                >
                  <UploadSimple size={15} />{" "}
                  {workspace.publishState === "never" ? "Publish branch" : "Publish update"}
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Delete ${workspace.label}`}
                  onClick={() => void deleteWorkspace(workspace.workspaceId, workspace.label)}
                >
                  <Trash size={15} />
                </button>
              </footer>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function LegacyWorktreesView({
  profile,
  snapshot,
  onSelectRun,
  onError,
  onNotice,
}: ProjectViewProps) {
  const [git, setGit] = useState<DesktopGitSnapshotV1>();
  const [busyRun, setBusyRun] = useState<string>();
  const [busyIntegration, setBusyIntegration] = useState<string>();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.honeybee.gitSnapshot({
          schemaVersion: 1,
          profileId: profile.profileId,
        });
        if (!stopped) setGit(next);
      } catch (error) {
        if (!stopped) onError?.(error instanceof Error ? error.message : "Git inspection failed.");
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [onError, profile.profileId]);

  const runAction = async (runId: string, action: "materialize" | "merge"): Promise<void> => {
    if (
      action === "merge" &&
      !window.confirm(
        "Merge this Work branch into the Run integration branch? The source branch remains unchanged.",
      )
    ) {
      return;
    }
    setBusyRun(runId);
    try {
      const request = { schemaVersion: 1 as const, profileId: profile.profileId, runId };
      const result =
        action === "materialize"
          ? await window.honeybee.materializeRunWorktree(request)
          : await window.honeybee.mergeRunWorktree(request);
      setGit(result.snapshot);
      if (result.disposition === "conflict") {
        onError?.(
          `Integration Work created for ${result.conflictPaths.length} conflict${result.conflictPaths.length === 1 ? "" : "s"}.`,
        );
      } else {
        onNotice?.(
          result.disposition === "materialized"
            ? "Verified patch committed to its Work branch."
            : "Work branch merged into the Run integration branch.",
        );
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Git worktree action failed.");
    } finally {
      setBusyRun(undefined);
    }
  };

  const finalizeIntegration = async (branch: string): Promise<void> => {
    const groupRunId = branch.split("/").at(-1);
    if (groupRunId === undefined || !/^[0-9a-f-]{36}$/u.test(groupRunId)) {
      onError?.("The integration branch is not linked to a durable Run.");
      return;
    }
    if (
      !window.confirm(
        `Fast-forward ${git?.currentBranch ?? "the source branch"} to this approved Run integration?`,
      )
    ) {
      return;
    }
    setBusyIntegration(branch);
    try {
      const result = await window.honeybee.finalizeIntegration({
        schemaVersion: 1,
        profileId: profile.profileId,
        runId: groupRunId,
      });
      setGit(result.snapshot);
      onNotice?.("Run integration applied to the source branch. Git branches were retained.");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Source integration failed.");
    } finally {
      setBusyIntegration(undefined);
    }
  };

  const source = git?.worktrees.find((worktree) => worktree.kind === "source");
  const integrations = git?.worktrees.filter((worktree) => worktree.kind === "integration") ?? [];
  const workRuns = (snapshot?.runs ?? []).filter((run) => run.workId !== undefined);
  return (
    <section className="project-surface worktrees-view">
      <header className="project-view-heading">
        <div>
          <span className="eyebrow">SOURCE INTEGRATION</span>
          <h1>Git Worktrees</h1>
          <p>
            Inspect isolated Agent branches and approve each merge into the Run integration branch.
          </p>
        </div>
      </header>
      <div className="worktree-repository-card">
        <GitBranch size={24} weight="duotone" />
        <span>
          <strong>
            {git?.available === true ? (git.currentBranch ?? "Git repository") : profile.label}
          </strong>
          <small>{git?.repositoryRoot ?? profile.projectPath}</small>
        </span>
        <span className={`status-pill ${source?.status === "clean" ? "ready" : ""}`}>
          {git === undefined
            ? "Inspecting repository…"
            : git.available
              ? (source?.status ?? "Git ready")
              : "Git unavailable"}
        </span>
      </div>
      {git?.available === false && <p className="worktree-message">{git.message}</p>}
      {integrations.map((worktree) => (
        <article
          className={`integration-worktree-card ${worktree.status === "conflict" ? "conflict" : ""}`}
          key={worktree.branch}
        >
          {worktree.status === "conflict" ? (
            <Warning size={20} weight="fill" />
          ) : (
            <GitMerge size={20} />
          )}
          <span>
            <small>
              {worktree.status === "conflict" ? "INTEGRATION WORK · CONFLICT" : "RUN INTEGRATION"}
            </small>
            <strong>{worktree.branch}</strong>
            <em>{worktree.path}</em>
          </span>
          <code>{worktree.head.slice(0, 8)}</code>
          <button
            className="primary"
            disabled={
              worktree.status !== "clean" || busyIntegration !== undefined || busyRun !== undefined
            }
            onClick={() => void finalizeIntegration(worktree.branch)}
          >
            {busyIntegration === worktree.branch ? (
              <SpinnerGap className="spin-icon" size={15} />
            ) : (
              <GitMerge size={15} />
            )}
            Apply integration
          </button>
        </article>
      ))}
      <div className="worktree-list">
        {workRuns.length === 0 ? (
          <div className="map-empty-state compact">
            <GitCommit size={38} weight="duotone" />
            <h2>No HoneyBee worktrees</h2>
            <p>Work branches appear here after an approved orchestration plan starts.</p>
          </div>
        ) : (
          workRuns.map((run) => {
            const worktree = git?.worktrees.find(
              (candidate) => candidate.kind === "work" && candidate.runId === run.runId,
            );
            return (
              <article className="worktree-run-row" key={run.runId}>
                <button className="worktree-run-link" onClick={() => onSelectRun(run.runId)}>
                  <GitBranch size={19} />
                  <span>
                    <strong>{worktree?.branch ?? `Work ${run.workId}`}</strong>
                    <small>
                      {worktree === undefined
                        ? `${run.phase} · ${run.status}`
                        : `${worktree.status} · ${worktree.head.slice(0, 8)}`}
                    </small>
                  </span>
                  <ArrowSquareOut size={17} />
                </button>
                <button
                  className={worktree === undefined ? "secondary" : "primary"}
                  disabled={!run.terminal || busyRun !== undefined || git?.available !== true}
                  onClick={() =>
                    void runAction(run.runId, worktree === undefined ? "materialize" : "merge")
                  }
                >
                  {busyRun === run.runId ? (
                    <SpinnerGap className="spin-icon" size={15} />
                  ) : worktree === undefined ? (
                    <GitCommit size={15} />
                  ) : (
                    <GitMerge size={15} />
                  )}
                  {worktree === undefined ? "Prepare branch" : "Approve merge"}
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

export function ProjectOperationsView({
  profile,
  snapshot,
  doctor,
  agents,
  onRunDoctor,
  onError,
}: ProjectViewProps) {
  const [git, setGit] = useState<DesktopGitSnapshotV1>();
  useEffect(() => {
    let stopped = false;
    void window.honeybee
      .gitSnapshot({ schemaVersion: 1, profileId: profile.profileId })
      .then((value) => {
        if (!stopped) setGit(value);
      })
      .catch((error: unknown) => {
        if (!stopped) onError?.(error instanceof Error ? error.message : "Git inspection failed.");
      });
    return () => {
      stopped = true;
    };
  }, [onError, profile.profileId]);
  const checks = doctor?.checks ?? [];
  const failures = checks.filter((check) => check.status === "fail").length;
  return (
    <section className="project-surface project-operations-view">
      <header className="project-view-heading">
        <div>
          <span className="eyebrow">PROJECT OPERATIONS</span>
          <h1>{profile.label}</h1>
          <p>
            Git, Unity, Agents, Components, storage, and Editor capacity in one operational view.
          </p>
        </div>
        <button className="secondary" onClick={onRunDoctor}>
          <Stethoscope size={17} /> Run Doctor
        </button>
      </header>
      <div className="operations-grid">
        <article>
          <GitBranch size={22} />
          <span>
            <small>Source</small>
            <strong>
              {git?.available === true
                ? (git.currentBranch ?? "Git repository")
                : "Git unavailable"}
            </strong>
            <em>
              {git?.available === true
                ? `${git.worktrees.length} worktree${git.worktrees.length === 1 ? "" : "s"}`
                : (git?.message ?? "Inspecting repository")}
            </em>
          </span>
        </article>
        <article>
          <Cpu size={22} />
          <span>
            <small>Editor Pool</small>
            <strong>
              {snapshot?.pool.active.length ?? 0}/{snapshot?.pool.capacity ?? "—"} active
            </strong>
            <em>{snapshot?.pool.queued.length ?? 0} queued</em>
          </span>
        </article>
        <article>
          <Code size={22} />
          <span>
            <small>Agents</small>
            <strong>{agents.filter((agent) => agent.enabled).length} enabled</strong>
            <em>{agents.length} configured</em>
          </span>
        </article>
        <article>
          <HardDrives size={22} />
          <span>
            <small>Workspace Storage</small>
            <strong>{profile.schemaVersion === 3 ? "Managed" : "Legacy"}</strong>
            <em>{profile.configLabel}</em>
          </span>
        </article>
        <article className={failures > 0 ? "danger" : ""}>
          {failures > 0 ? (
            <Warning size={22} weight="fill" />
          ) : (
            <CheckCircle size={22} weight="fill" />
          )}
          <span>
            <small>Environment</small>
            <strong>
              {doctor === undefined
                ? "Not checked"
                : failures > 0
                  ? `${failures} failures`
                  : "Ready"}
            </strong>
            <em>{checks.length} checks observed</em>
          </span>
        </article>
        <article>
          <Circle size={22} weight="fill" />
          <span>
            <small>Runs</small>
            <strong>{snapshot?.runs.length ?? 0} durable</strong>
            <em>{snapshot?.runs.filter((run) => !run.terminal).length ?? 0} active</em>
          </span>
        </article>
      </div>
    </section>
  );
}
