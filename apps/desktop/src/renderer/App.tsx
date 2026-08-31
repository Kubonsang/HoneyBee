import { useEffect, useMemo, useRef, useState } from "react";
import { Cube, FolderSimple, Plus, Pulse, SquaresFour, X } from "@phosphor-icons/react";

import type {
  ArtifactViewV1,
  DoctorReportV1,
  PatchActionV1,
  RunActionV1,
  RunDetailV1,
  VerifiedPatchViewV1,
} from "@honeybee/control-plane-contracts";

import {
  DesktopStartRequestV2Schema,
  type DesktopBootstrapV2,
  type DesktopPendingAgentApprovalV1,
  type DesktopPreferencesV1,
  type DesktopProjectCatalogEntryV1,
  type DesktopProjectCatalogV1,
  type DesktopProjectProfile,
  type DesktopRuntimeSnapshotV1,
} from "../shared/ipc.js";
import { AgentManagerView } from "./AgentManagerView.js";
import { CommandCenter } from "./CommandCenter.js";
import { DesktopShell, type DesktopShellMode, type DesktopView } from "./DesktopShell.js";
import { DogfoodMetricsPanel } from "./DogfoodMetricsPanel.js";
import { DesktopPreferencesPanel } from "./DesktopPreferencesPanel.js";
import { ProjectOperationsView, WorkMapView, WorktreesView } from "./ProjectViews.js";
import { ProjectWorkbench } from "./ProjectWorkbench.js";
import { RawProtocolSettingsPanel } from "./RawProtocolSettingsPanel.js";
import { SetupCenter } from "./SetupCenter.js";
import { WorkspaceView, type UtilityTab, type WorkDraft } from "./WorkspaceView.js";

const initialWork = (key = 1): WorkDraft => ({
  key,
  id: `work-${key}`,
  task: "",
  priority: "validation",
  compile: false,
  warmTest: false,
  filter: "",
  agentId: undefined,
  unavailableAgent: undefined,
});

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "HoneyBee operation failed.";

const hasOperationCode = (error: unknown, code: string): boolean =>
  readableError(error).includes(`HoneyBee operation failed (${code}):`);

export function App() {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapV2>();
  const [projectCatalog, setProjectCatalog] = useState<DesktopProjectCatalogV1>();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [editingProfileId, setEditingProfileId] = useState<string>();
  const [setupProjectPath, setSetupProjectPath] = useState<string>();
  const [shellMode, setShellMode] = useState<DesktopShellMode>("hub");
  const [view, setView] = useState<DesktopView>("projects");
  const [doctor, setDoctor] = useState<DoctorReportV1>();
  const [works, setWorks] = useState<readonly WorkDraft[]>([initialWork()]);
  const [maxParallelWorks, setMaxParallelWorks] = useState(1);
  const [composing, setComposing] = useState(false);
  const [planReviewOpen, setPlanReviewOpen] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferencesV1>();
  const [busy, setBusy] = useState<"profile" | "doctor" | "start">();
  const [detailBusy, setDetailBusy] = useState<
    "artifact" | RunActionV1 | PatchActionV1 | "clone"
  >();
  const [snapshot, setSnapshot] = useState<DesktopRuntimeSnapshotV1>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [runDetail, setRunDetail] = useState<RunDetailV1>();
  const [artifact, setArtifact] = useState<ArtifactViewV1>();
  const [patch, setPatch] = useState<VerifiedPatchViewV1>();
  const [patchLoading, setPatchLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [defaultAgentId, setDefaultAgentId] = useState<string>();
  const [agentApprovals, setAgentApprovals] = useState<readonly DesktopPendingAgentApprovalV1[]>(
    [],
  );
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityTab, setUtilityTab] = useState<UtilityTab>("runs");
  const [terminalDismissedRuns, setTerminalDismissedRuns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const lastTerminalRunRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    void window.honeybee
      .bootstrap()
      .then((value) => {
        setBootstrap(value);
        setSelectedProfileId(undefined);
        setDefaultAgentId(value.lastUsedAgentId);
        setShellMode("hub");
        setView("projects");
      })
      .catch((reason: unknown) => setError(readableError(reason)));
  }, []);

  useEffect(() => {
    void window.honeybee
      .preferences()
      .then(setPreferences)
      .catch((reason: unknown) => setError(readableError(reason)));
  }, []);

  useEffect(() => {
    if (preferences === undefined) return;
    const root = document.documentElement;
    root.dataset.density = preferences.density;
    root.dataset.reducedMotion = String(preferences.reducedMotion);
    root.style.setProperty("--hb-explorer-width", `${preferences.fileExplorerWidth}px`);
    root.style.setProperty("--hb-terminal-font-size", String(preferences.terminalFontSize));
  }, [preferences]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    let stopped = false;
    void window.honeybee
      .projectCatalog()
      .then((catalog) => {
        if (!stopped) setProjectCatalog(catalog);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(readableError(reason));
      });
    return () => {
      stopped = true;
    };
  }, [bootstrap]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const value = await window.honeybee.listAgentApprovals();
        if (!stopped) setAgentApprovals(value.approvals);
      } catch (reason) {
        if (!stopped) setError(readableError(reason));
      }
      if (!stopped) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (selectedProfileId === undefined) {
      setSnapshot(undefined);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.honeybee.runtimeSnapshot({
          schemaVersion: 1,
          profileId: selectedProfileId,
        });
        if (stopped) return;
        setSnapshot(next);
        const active =
          next.runs.some((run) => !run.terminal) ||
          next.pool.active.length > 0 ||
          next.pool.queued.length > 0;
        timer = setTimeout(() => void poll(), active ? 500 : 2_000);
      } catch (reason) {
        if (stopped) return;
        if (hasOperationCode(reason, "desktop.profile-not-found")) {
          try {
            const value = await window.honeybee.bootstrap();
            if (stopped) return;
            const profileId = value.profiles[0]?.profileId;
            setBootstrap(value);
            setSelectedProfileId(profileId);
            setDefaultAgentId(
              profileId === undefined
                ? value.lastUsedAgentId
                : (value.preferredAgentIds[profileId] ?? value.lastUsedAgentId),
            );
            setSnapshot(undefined);
            setSelectedRunId(undefined);
            setRunDetail(undefined);
            setArtifact(undefined);
            setPatch(undefined);
            setError(undefined);
            setShellMode(profileId === undefined ? "hub" : "project");
            setView(profileId === undefined ? "projects" : "workspace");
            setNotice("Project setup changed. HoneyBee refreshed the active project profile.");
            return;
          } catch {
            // Report the original typed error if bootstrap reconciliation also fails.
          }
        }
        setError(readableError(reason));
        timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [selectedProfileId]);

  useEffect(() => {
    if (
      view !== "workspace" ||
      composing ||
      selectedRunId !== undefined ||
      snapshot === undefined
    ) {
      return;
    }
    const active = snapshot.runs.find((run) => !run.terminal);
    if (active !== undefined) setSelectedRunId(active.runId);
  }, [composing, selectedRunId, snapshot, view]);

  useEffect(() => {
    const active =
      selectedRunId !== undefined &&
      snapshot?.runs.find((run) => run.runId === selectedRunId)?.terminal === false;
    if (!active || selectedRunId === undefined) {
      lastTerminalRunRef.current = undefined;
      return;
    }
    if (lastTerminalRunRef.current === selectedRunId) return;
    lastTerminalRunRef.current = selectedRunId;
    if (terminalDismissedRuns.has(selectedRunId)) return;
    setUtilityTab("terminal");
    setUtilityOpen(true);
  }, [selectedRunId, snapshot, terminalDismissedRuns]);

  useEffect(() => {
    if (selectedRunId === undefined) {
      setRunDetail(undefined);
      setArtifact(undefined);
      setPatch(undefined);
      return;
    }
    let stopped = false;
    void window.honeybee
      .runDetail({ schemaVersion: 1, runId: selectedRunId })
      .then((detail) => {
        if (!stopped) setRunDetail(detail);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(readableError(reason));
      });
    return () => {
      stopped = true;
    };
  }, [selectedRunId, snapshot?.observedAt]);

  const patchArtifactId = runDetail?.artifacts.find(
    (item) => item.kind === "unity-verified-patch",
  )?.artifactId;

  useEffect(() => {
    if (
      selectedRunId === undefined ||
      patchArtifactId === undefined ||
      patch?.patch.artifactId === patchArtifactId
    ) {
      setPatchLoading(false);
      return;
    }
    let stopped = false;
    setPatchLoading(true);
    void window.honeybee
      .getPatch({
        schemaVersion: 1,
        runId: selectedRunId,
        patchArtifactId,
      })
      .then((value) => {
        if (!stopped) setPatch(value);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(readableError(reason));
      })
      .finally(() => {
        if (!stopped) setPatchLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [patch?.patch.artifactId, patchArtifactId, selectedRunId]);

  const selectedProfile = useMemo(
    () => bootstrap?.profiles.find((profile) => profile.profileId === selectedProfileId),
    [bootstrap, selectedProfileId],
  );
  const catalogProjects = useMemo<readonly DesktopProjectCatalogEntryV1[]>(
    () =>
      projectCatalog?.projects ??
      bootstrap?.profiles.map((profile) => ({
        schemaVersion: 1 as const,
        projectPath: profile.projectPath,
        label: profile.label,
        source: "managed" as const,
        profileId: profile.profileId,
        lastOpenedAt: profile.lastOpenedAt,
      })) ??
      [],
    [bootstrap, projectCatalog],
  );
  const enabledAgents = useMemo(
    () => bootstrap?.agents.filter((agent) => agent.enabled) ?? [],
    [bootstrap],
  );
  const testplayAvailable =
    selectedProfile === undefined ||
    selectedProfile.schemaVersion === 1 ||
    selectedProfile.environment.testplay !== undefined;
  const validWorks =
    selectedProfile !== undefined &&
    defaultAgentId !== undefined &&
    doctor?.ok === true &&
    maxParallelWorks >= 1 &&
    maxParallelWorks <= works.length &&
    works.every(
      (work) =>
        work.task.trim().length > 0 &&
        work.unavailableAgent === undefined &&
        (testplayAvailable || (!work.compile && !work.warmTest)),
    );

  const activateProfile = (
    profileId: string | undefined,
    source: DesktopBootstrapV2 | undefined = bootstrap,
  ): void => {
    setSelectedProfileId(profileId);
    setDefaultAgentId(
      profileId === undefined
        ? source?.lastUsedAgentId
        : (source?.preferredAgentIds[profileId] ?? source?.lastUsedAgentId),
    );
    setDoctor(undefined);
    setSnapshot(undefined);
    setSelectedRunId(undefined);
    setRunDetail(undefined);
    setArtifact(undefined);
    setPatch(undefined);
    setComposing(false);
  };

  const removeProfile = async (profile: DesktopProjectProfile): Promise<void> => {
    if (
      !window.confirm(`Remove ${profile.label} from HoneyBee? The Unity project is not deleted.`)
    ) {
      return;
    }
    setError(undefined);
    try {
      const value = await window.honeybee.removeProfile({
        schemaVersion: 1,
        profileId: profile.profileId,
      });
      setBootstrap(value);
      setProjectCatalog(undefined);
      if (selectedProfileId === profile.profileId) {
        activateProfile(undefined, value);
        setShellMode("hub");
        setView("projects");
      }
    } catch (reason) {
      setError(readableError(reason));
    }
  };

  const completeSetup = async (profile: DesktopProjectProfile): Promise<void> => {
    try {
      const value = await window.honeybee.bootstrap();
      setBootstrap(value);
      activateProfile(profile.profileId, value);
      setEditingProfileId(undefined);
      setSetupProjectPath(undefined);
      setShellMode("project");
      setView("workspace");
      setComposing(true);
      setNotice(`${profile.label} is ready. Run Doctor before the first Work.`);
    } catch (reason) {
      setError(readableError(reason));
    }
  };

  const refreshBootstrap = async (): Promise<void> => {
    const value = await window.honeybee.bootstrap();
    setBootstrap(value);
    setProjectCatalog(undefined);
    const profileId =
      shellMode === "project" &&
      value.profiles.some((profile) => profile.profileId === selectedProfileId)
        ? selectedProfileId
        : undefined;
    setSelectedProfileId(profileId);
    setDefaultAgentId(
      profileId === undefined
        ? value.lastUsedAgentId
        : (value.preferredAgentIds[profileId] ?? value.lastUsedAgentId),
    );
  };

  const runDoctor = async (): Promise<void> => {
    if (selectedProfile === undefined) return;
    setBusy("doctor");
    setError(undefined);
    try {
      setDoctor(
        await window.honeybee.doctor({
          schemaVersion: 1,
          profileId: selectedProfile.profileId,
        }),
      );
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const updateWork = (key: number, update: Partial<WorkDraft>): void => {
    setWorks((current) =>
      current.map((work) => (work.key === key ? { ...work, ...update } : work)),
    );
  };

  const addWork = (): void => {
    setWorks((current) => {
      const nextKey = Math.max(...current.map((work) => work.key)) + 1;
      const next = [...current, initialWork(nextKey)];
      setMaxParallelWorks(next.length);
      return next;
    });
  };

  const removeWork = (key: number): void => {
    setWorks((current) => {
      const next = current.filter((work) => work.key !== key);
      setMaxParallelWorks((value) => Math.max(1, Math.min(value, next.length)));
      return next;
    });
  };

  const reviewPlan = (): void => {
    if (!validWorks) return;
    setPlanReviewOpen(true);
  };

  const startWorks = async (): Promise<void> => {
    if (selectedProfile === undefined || !validWorks || defaultAgentId === undefined) return;
    setPlanReviewOpen(false);
    setBusy("start");
    setError(undefined);
    setNotice(undefined);
    try {
      const request = DesktopStartRequestV2Schema.parse({
        schemaVersion: 2,
        profileId: selectedProfile.profileId,
        defaultAgentId,
        maxParallelWorks,
        works: works.map((work) => ({
          id: work.id,
          task: work.task.trim(),
          priority: work.priority,
          ...(work.agentId === undefined ? {} : { agentId: work.agentId }),
          capabilities: [
            ...(work.compile ? [{ id: "compile" as const, kind: "compile" as const }] : []),
            ...(work.warmTest
              ? [
                  {
                    id: "warm-test" as const,
                    kind: "warm-test" as const,
                    ...(work.filter.trim().length === 0 ? {} : { filter: work.filter.trim() }),
                  },
                ]
              : []),
          ],
        })),
      });
      const result = await window.honeybee.startWorks(request);
      setNotice(`Run started · ${result.runId}`);
      setSelectedRunId(result.runId);
      setRunDetail(undefined);
      setArtifact(undefined);
      setPatch(undefined);
      setComposing(false);
      setTerminalDismissedRuns((current) => {
        const next = new Set(current);
        next.delete(result.runId);
        return next;
      });
      setUtilityTab("terminal");
      setUtilityOpen(true);
      setShellMode("project");
      setView("workspace");
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const readArtifact = async (artifactId: string): Promise<void> => {
    if (selectedRunId === undefined) return;
    setDetailBusy("artifact");
    setError(undefined);
    try {
      setArtifact(
        await window.honeybee.readArtifact({
          schemaVersion: 1,
          runId: selectedRunId,
          artifactId,
        }),
      );
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setDetailBusy(undefined);
    }
  };

  const controlPatch = async (action: PatchActionV1): Promise<void> => {
    if (selectedRunId === undefined || patch === undefined) return;
    const question =
      action === "apply"
        ? "Apply this verified patch to the original Unity project?"
        : "Reject this verified patch permanently?";
    if (!window.confirm(question)) return;
    setDetailBusy(action);
    setError(undefined);
    try {
      const result = await window.honeybee.controlPatch({
        schemaVersion: 1,
        runId: selectedRunId,
        patchArtifactId: patch.patch.artifactId,
        action,
      });
      setNotice(`Patch ${result.disposition}`);
      setPatch(
        await window.honeybee.getPatch({
          schemaVersion: 1,
          runId: selectedRunId,
          patchArtifactId: patch.patch.artifactId,
        }),
      );
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setDetailBusy(undefined);
    }
  };

  const controlRun = async (action: RunActionV1): Promise<void> => {
    if (selectedRunId === undefined) return;
    setDetailBusy(action);
    setError(undefined);
    try {
      const request = { schemaVersion: 1 as const, runId: selectedRunId };
      const result =
        action === "resume"
          ? await window.honeybee.resumeRun(request)
          : await window.honeybee.cancelRun(request);
      setNotice(
        `${action} ${result.disposition}${result.requiresResume ? " · resume required" : ""}`,
      );
      setRunDetail(await window.honeybee.runDetail(request));
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setDetailBusy(undefined);
    }
  };

  const cloneRun = async (): Promise<void> => {
    if (selectedRunId === undefined) return;
    setDetailBusy("clone");
    setError(undefined);
    try {
      const cloned = await window.honeybee.cloneRunDraft({
        schemaVersion: 1,
        runId: selectedRunId,
      });
      activateProfile(cloned.profileId);
      setWorks(
        cloned.works.map((work, index) => ({
          key: index + 1,
          id: work.id,
          task: work.task,
          priority: work.priority,
          compile: work.compile,
          warmTest: work.warmTest,
          filter: work.filter,
          agentId: work.agentId ?? undefined,
          unavailableAgent: work.agentId === null ? work.agentLabel : undefined,
        })),
      );
      setMaxParallelWorks(cloned.maxParallelWorks);
      setDefaultAgentId(cloned.defaultAgentId ?? undefined);
      setComposing(true);
      setShellMode("project");
      setView("workspace");
      setUtilityOpen(false);
      setNotice(
        cloned.works.some((work) => work.agentId === null)
          ? "Draft cloned. Choose replacements for unavailable Agents before running."
          : "Draft cloned from the durable Run. Review it before starting.",
      );
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setDetailBusy(undefined);
    }
  };

  const respondAgentApproval = async (
    approvalId: string,
    decision: "allow-once" | "deny",
  ): Promise<void> => {
    try {
      const value = await window.honeybee.respondAgentApproval({
        schemaVersion: 1,
        approvalId,
        decision,
      });
      setAgentApprovals(value.approvals);
      setNotice(decision === "allow-once" ? "Agent action allowed once." : "Agent action denied.");
    } catch (reason) {
      setError(readableError(reason));
    }
  };

  const selectRun = (runId: string): void => {
    setSelectedRunId(runId);
    setRunDetail(undefined);
    setArtifact(undefined);
    setPatch(undefined);
    setComposing(false);
    setUtilityOpen(false);
    setShellMode("project");
    setView("workspace");
  };

  const beginNewWork = (): void => {
    setWorks([initialWork()]);
    setMaxParallelWorks(1);
    setSelectedRunId(undefined);
    setRunDetail(undefined);
    setArtifact(undefined);
    setPatch(undefined);
    setComposing(true);
    setPlanReviewOpen(false);
    setUtilityOpen(false);
    setShellMode("project");
    setView("workspace");
  };

  const pageTitle =
    view === "runs"
      ? "Runs"
      : view === "projects"
        ? "Projects"
        : view === "setup"
          ? "Setup Center"
          : view === "agents"
            ? "Agents"
            : view === "settings"
              ? "Settings"
              : undefined;

  return (
    <>
      <DesktopShell
        mode={shellMode}
        view={view}
        profile={selectedProfile}
        runCount={snapshot?.runs.length ?? 0}
        activeRunCount={snapshot?.runs.filter((run) => !run.terminal).length ?? 0}
        runtimeVersion={bootstrap?.runtime.runtimeVersion}
        onView={(nextView) => {
          setView(nextView);
          if (nextView !== "workspace") {
            setComposing(false);
            setUtilityOpen(false);
          }
        }}
        onHub={() => {
          activateProfile(undefined);
          setShellMode("hub");
          setView("projects");
        }}
        onNewWork={beginNewWork}
      >
        {pageTitle !== undefined && (
          <header className="section-heading">
            <span className="eyebrow">HONEYBEE DESKTOP</span>
            <h1>{pageTitle}</h1>
            <p>
              {view === "projects"
                ? "Choose a Unity project or prepare a new managed environment."
                : view === "runs"
                  ? "Inspect active and durable Runs, then open any Run for its timeline and review."
                  : view === "setup"
                    ? "Create and recover a strict local managed Unity environment."
                    : view === "agents"
                      ? "Connect and manage AI execution profiles independently of projects."
                      : "Developer diagnostics and local Desktop preferences."}
            </p>
          </header>
        )}

        {agentApprovals.map((approval) => (
          <section className="agent-approval" key={approval.approvalId}>
            <span className="approval-icon">
              <Pulse size={20} weight="fill" />
            </span>
            <div>
              <span>AGENT APPROVAL · {approval.kind}</span>
              <strong>{approval.summary}</strong>
              <small>
                Run {approval.runId.slice(0, 8)} · {approval.stepId}
              </small>
            </div>
            <button
              className="secondary"
              onClick={() => void respondAgentApproval(approval.approvalId, "deny")}
            >
              Deny
            </button>
            <button
              className="primary"
              onClick={() => void respondAgentApproval(approval.approvalId, "allow-once")}
            >
              Allow once
            </button>
          </section>
        ))}

        {view === "work-map" && selectedProfile !== undefined ? (
          <WorkMapView
            profile={selectedProfile}
            snapshot={snapshot}
            doctor={doctor}
            agents={bootstrap?.agents ?? []}
            onRunDoctor={() => void runDoctor()}
            onSelectRun={selectRun}
            onNewWork={beginNewWork}
          />
        ) : view === "worktrees" && selectedProfile !== undefined ? (
          <WorktreesView
            profile={selectedProfile}
            snapshot={snapshot}
            doctor={doctor}
            agents={bootstrap?.agents ?? []}
            onRunDoctor={() => void runDoctor()}
            onSelectRun={selectRun}
            onNewWork={beginNewWork}
            onError={setError}
            onNotice={setNotice}
          />
        ) : view === "project" && selectedProfile !== undefined ? (
          <ProjectOperationsView
            profile={selectedProfile}
            snapshot={snapshot}
            doctor={doctor}
            agents={bootstrap?.agents ?? []}
            onRunDoctor={() => void runDoctor()}
            onSelectRun={selectRun}
            onNewWork={beginNewWork}
            onError={setError}
          />
        ) : view === "runs" && selectedProfile !== undefined ? (
          <CommandCenter
            snapshot={snapshot}
            selectedRunId={selectedRunId}
            historyOnly
            onSelectRun={selectRun}
          />
        ) : view === "projects" ? (
          <section className="projects-home">
            <div className="projects-toolbar">
              <div>
                <span>{bootstrap?.profiles.length ?? 0} managed projects</span>
                <strong>
                  {catalogProjects.length} Unity projects · choose exactly one workspace
                </strong>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setEditingProfileId(undefined);
                  setSetupProjectPath(undefined);
                  setView("setup");
                }}
              >
                <Plus size={17} /> Add project
              </button>
            </div>
            {catalogProjects.length === 0 ? (
              <div className="empty-projects">
                <FolderSimple size={38} weight="duotone" />
                <h2>Add your first Unity project</h2>
                <p>HoneyBee will detect Unity, prepare isolation, and connect an Agent.</p>
                <button
                  className="primary"
                  onClick={() => {
                    setEditingProfileId(undefined);
                    setSetupProjectPath(undefined);
                    setView("setup");
                  }}
                >
                  Choose project
                </button>
              </div>
            ) : (
              <div className="projects-grid">
                {catalogProjects.map((project) => {
                  const profile = bootstrap?.profiles.find(
                    (candidate) => candidate.profileId === project.profileId,
                  );
                  return (
                    <article className="project-tile" key={project.projectPath}>
                      <span className="project-glyph">
                        <Cube size={22} weight="duotone" />
                      </span>
                      <div>
                        <h2>{project.label}</h2>
                        <p title={project.projectPath}>{project.projectPath}</p>
                        <small>
                          {profile === undefined
                            ? `Unity Hub${project.projectVersion === undefined ? "" : ` · ${project.projectVersion}`} · setup required`
                            : profile.schemaVersion === 3
                              ? "Ready · managed environment"
                              : profile.configLabel}
                        </small>
                      </div>
                      <div className="project-tile-actions">
                        <button
                          className="primary"
                          onClick={() => {
                            if (profile === undefined) {
                              setEditingProfileId(undefined);
                              setSetupProjectPath(project.projectPath);
                              setView("setup");
                            } else {
                              activateProfile(profile.profileId);
                              setShellMode("project");
                              setView("workspace");
                            }
                          }}
                        >
                          {profile === undefined ? "Set up project" : "Open Workspace"}
                        </button>
                        {profile !== undefined && (
                          <>
                            <button
                              className="secondary"
                              onClick={() => {
                                activateProfile(profile.profileId);
                                setEditingProfileId(profile.profileId);
                                setSetupProjectPath(undefined);
                                setShellMode("project");
                                setView("setup");
                              }}
                            >
                              Project Settings
                            </button>
                            <button
                              className="icon-button danger"
                              onClick={() => void removeProfile(profile)}
                              aria-label={`Remove ${profile.label}`}
                            >
                              <X size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : view === "setup" ? (
          <SetupCenter
            key={editingProfileId ?? setupProjectPath ?? "new-project"}
            {...(setupProjectPath === undefined ? {} : { initialProjectPath: setupProjectPath })}
            {...(() => {
              const initialProfile = bootstrap?.profiles.find(
                (profile) => profile.profileId === editingProfileId,
              );
              return initialProfile === undefined ? {} : { initialProfile };
            })()}
            agents={bootstrap?.agents ?? []}
            {...(() => {
              const preferredAgentId =
                editingProfileId === undefined
                  ? bootstrap?.lastUsedAgentId
                  : bootstrap?.preferredAgentIds[editingProfileId];
              return preferredAgentId === undefined ? {} : { preferredAgentId };
            })()}
            onManageAgents={() => setView("agents")}
            onComplete={(profile) => void completeSetup(profile)}
            onError={(message) => setError(message)}
          />
        ) : view === "agents" ? (
          <AgentManagerView
            agents={bootstrap?.agents ?? []}
            statuses={bootstrap?.agentStatuses ?? []}
            onChange={refreshBootstrap}
            onError={(message) => setError(message)}
            onNotice={(message) => setNotice(message)}
          />
        ) : view === "settings" ? (
          <div className="settings-layout">
            <DesktopPreferencesPanel
              onChange={setPreferences}
              onError={setError}
              onNotice={setNotice}
            />
            <RawProtocolSettingsPanel
              onError={(message) => setError(message)}
              onNotice={(message) => setNotice(message)}
            />
            <DogfoodMetricsPanel
              {...(selectedProfileId === undefined ? {} : { profileId: selectedProfileId })}
              onError={(message) => setError(message)}
              onNotice={(message) => setNotice(message)}
            />
          </div>
        ) : selectedProfile === undefined ? (
          <section className="empty-projects">
            <SquaresFour size={38} weight="duotone" />
            <h2>Choose a Unity project</h2>
            <p>Link a managed project before creating or inspecting Work.</p>
            <button className="primary" onClick={() => setView("projects")}>
              Open Projects
            </button>
          </section>
        ) : (
          <ProjectWorkbench
            profile={selectedProfile}
            agents={enabledAgents}
            defaultAgentId={defaultAgentId}
            composing={composing}
            preferences={preferences}
            onError={setError}
          >
            <WorkspaceView
              profile={selectedProfile}
              snapshot={snapshot}
              selectedRunId={selectedRunId}
              detail={runDetail}
              patch={patch}
              artifact={artifact}
              doctor={doctor}
              works={works}
              agents={enabledAgents}
              defaultAgentId={defaultAgentId}
              maxParallelWorks={maxParallelWorks}
              composing={composing}
              testplayAvailable={testplayAvailable}
              canStart={validWorks && busy === undefined}
              busy={busy}
              detailBusy={detailBusy ?? (patchLoading ? "artifact" : undefined)}
              utilityOpen={utilityOpen}
              utilityTab={utilityTab}
              onUpdateWork={updateWork}
              onAddWork={addWork}
              onRemoveWork={removeWork}
              onDefaultAgent={setDefaultAgentId}
              onMaxParallelWorks={(value) =>
                setMaxParallelWorks(Math.max(1, Math.min(works.length, value || 1)))
              }
              onStart={reviewPlan}
              onRunDoctor={() => void runDoctor()}
              onSelectRun={selectRun}
              onControlRun={(action) => void controlRun(action)}
              onReadArtifact={(artifactId) => void readArtifact(artifactId)}
              onPatchControl={(action) => void controlPatch(action)}
              onCloneRun={() => void cloneRun()}
              onTerminalError={setError}
              onUtility={(tab, open = true) => {
                if (tab === "terminal" && selectedRunId !== undefined) {
                  setTerminalDismissedRuns((current) => {
                    const next = new Set(current);
                    if (open) next.delete(selectedRunId);
                    else next.add(selectedRunId);
                    return next;
                  });
                }
                setUtilityTab(tab);
                setUtilityOpen(open);
              }}
            />
          </ProjectWorkbench>
        )}
      </DesktopShell>

      {planReviewOpen && selectedProfile !== undefined && (
        <div className="plan-review-backdrop" role="presentation">
          <section
            className="plan-review-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Review Work plan"
          >
            <header>
              <div>
                <span className="eyebrow">EXECUTION PLAN</span>
                <h2>Review the Work DAG</h2>
                <p>
                  HoneyBee will run up to {maxParallelWorks} Work{maxParallelWorks === 1 ? "" : "s"}{" "}
                  in parallel. Nothing starts until you approve this plan.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setPlanReviewOpen(false)}
                aria-label="Close plan review"
              >
                <X size={17} />
              </button>
            </header>
            <div className="plan-review-project">
              <Cube size={19} weight="duotone" />
              <span>
                <strong>{selectedProfile.label}</strong>
                <small>{selectedProfile.projectPath}</small>
              </span>
              <em>{works.length} Work nodes</em>
            </div>
            <div className="plan-review-dag">
              <div className="plan-review-nodes">
                {works.map((work, index) => {
                  const assignedAgent = enabledAgents.find(
                    (agent) => agent.agentId === (work.agentId ?? defaultAgentId),
                  );
                  return (
                    <article key={work.key}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{work.id}</strong>
                        <p>{work.task.trim()}</p>
                        <small>
                          {assignedAgent?.displayName ?? "Agent unavailable"} · {work.priority}
                          {work.compile ? " · compile" : ""}
                          {work.warmTest ? " · warm test" : ""}
                        </small>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="plan-dag-arrow" aria-hidden="true">
                →
              </div>
              <article className="plan-integration-node">
                <SquaresFour size={23} weight="duotone" />
                <strong>Review & integrate</strong>
                <small>Verified patches remain gated by your approval.</small>
              </article>
            </div>
            <footer>
              <span>Agent actions may still request one-time approval during execution.</span>
              <button className="secondary" onClick={() => setPlanReviewOpen(false)}>
                Back to edit
              </button>
              <button
                className="primary"
                onClick={() => void startWorks()}
                disabled={busy !== undefined}
              >
                Approve plan & start
              </button>
            </footer>
          </section>
        </div>
      )}

      {error !== undefined && (
        <div className="toast error-toast">
          <span>{error}</span>
          <button onClick={() => setError(undefined)} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      {notice !== undefined && (
        <div className="toast success-toast">
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)} aria-label="Dismiss message">
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
