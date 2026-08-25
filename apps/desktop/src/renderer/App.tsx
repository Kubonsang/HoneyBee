import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  ClockCounterClockwise,
  Cube,
  FirstAidKit,
  Folders,
  Gear,
  Hexagon,
  ListChecks,
  Plus,
  Play,
  Pulse,
  SquaresFour,
  Stethoscope,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";

import type {
  ArtifactViewV1,
  DoctorReportV1,
  PatchActionV1,
  RunActionV1,
  RunDetailV1,
  VerifiedPatchViewV1,
} from "@honeybee/control-plane-contracts";

import {
  DesktopStartRequestV1Schema,
  type DesktopBootstrapV1,
  type DesktopProjectProfile,
  type DesktopRuntimeSnapshotV1,
} from "../shared/ipc.js";
import { CommandCenter } from "./CommandCenter.js";
import { RunDetailView } from "./RunDetailView.js";
import { SetupCenter } from "./SetupCenter.js";

type DesktopView = "projects" | "command" | "work" | "history" | "setup";

interface WorkDraft {
  readonly key: number;
  readonly id: string;
  readonly task: string;
  readonly priority: "interactive" | "validation" | "background";
  readonly compile: boolean;
  readonly warmTest: boolean;
  readonly filter: string;
}

const initialWork = (key = 1): WorkDraft => ({
  key,
  id: `work-${key}`,
  task: "",
  priority: "validation",
  compile: false,
  warmTest: false,
  filter: "",
});

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "HoneyBee operation failed.";

const statusMark = (status: "pass" | "warning" | "fail") =>
  status === "pass" ? (
    <CheckCircle size={17} weight="fill" />
  ) : status === "warning" ? (
    <WarningCircle size={17} weight="fill" />
  ) : (
    <XCircle size={17} weight="fill" />
  );

export function App() {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapV1>();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [editingProfileId, setEditingProfileId] = useState<string>();
  const [view, setView] = useState<DesktopView>("projects");
  const [doctor, setDoctor] = useState<DoctorReportV1>();
  const [works, setWorks] = useState<readonly WorkDraft[]>([initialWork()]);
  const [busy, setBusy] = useState<"profile" | "doctor" | "start">();
  const [detailBusy, setDetailBusy] = useState<"artifact" | RunActionV1 | PatchActionV1>();
  const [snapshot, setSnapshot] = useState<DesktopRuntimeSnapshotV1>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [runDetail, setRunDetail] = useState<RunDetailV1>();
  const [artifact, setArtifact] = useState<ArtifactViewV1>();
  const [patch, setPatch] = useState<VerifiedPatchViewV1>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    void window.honeybee
      .bootstrap()
      .then((value) => {
        setBootstrap(value);
        setSelectedProfileId(value.profiles[0]?.profileId);
        setView("projects");
      })
      .catch((reason: unknown) => setError(readableError(reason)));
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

  const selectedProfile = useMemo(
    () => bootstrap?.profiles.find((profile) => profile.profileId === selectedProfileId),
    [bootstrap, selectedProfileId],
  );
  const agentProfiles = useMemo(
    () =>
      selectedProfile === undefined
        ? []
        : (bootstrap?.profiles.filter(
            (profile) => profile.projectPath === selectedProfile.projectPath,
          ) ?? []),
    [bootstrap, selectedProfile],
  );
  const testplayAvailable =
    selectedProfile === undefined ||
    selectedProfile.schemaVersion === 1 ||
    selectedProfile.environment.testplay !== undefined;
  const validWorks = works.every(
    (work) =>
      work.task.trim().length > 0 && (testplayAvailable || (!work.compile && !work.warmTest)),
  );
  const primaryWork = works[0] ?? initialWork();

  const activateProfile = (profileId: string | undefined): void => {
    setSelectedProfileId(profileId);
    setDoctor(undefined);
    setSnapshot(undefined);
    setSelectedRunId(undefined);
    setRunDetail(undefined);
    setArtifact(undefined);
    setPatch(undefined);
  };

  const removeProfile = async (profile: DesktopProjectProfile): Promise<void> => {
    setError(undefined);
    try {
      const value = await window.honeybee.removeProfile({
        schemaVersion: 1,
        profileId: profile.profileId,
      });
      setBootstrap(value);
      if (selectedProfileId === profile.profileId) {
        activateProfile(value.profiles[0]?.profileId);
      }
    } catch (reason) {
      setError(readableError(reason));
    }
  };

  const completeSetup = async (profile: DesktopProjectProfile): Promise<void> => {
    try {
      const value = await window.honeybee.bootstrap();
      setBootstrap(value);
      activateProfile(profile.profileId);
      setEditingProfileId(undefined);
      setView("command");
      setNotice(`${profile.label} is ready. Run Doctor before the first Work.`);
    } catch (reason) {
      setError(readableError(reason));
    }
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

  const startWorks = async (): Promise<void> => {
    if (selectedProfile === undefined || !validWorks) return;
    setBusy("start");
    setError(undefined);
    setNotice(undefined);
    try {
      const request = DesktopStartRequestV1Schema.parse({
        schemaVersion: 1,
        profileId: selectedProfile.profileId,
        maxParallelWorks: works.length,
        works: works.map((work) => ({
          id: work.id,
          task: work.task.trim(),
          priority: work.priority,
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
      setNotice("Run started · " + result.runId);
      setSelectedRunId(result.runId);
      setRunDetail(undefined);
      setArtifact(undefined);
      setPatch(undefined);
      setView("command");
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
    setPatch(undefined);
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

  const readPatch = async (patchArtifactId: string): Promise<void> => {
    if (selectedRunId === undefined) return;
    setDetailBusy("artifact");
    setError(undefined);
    setArtifact(undefined);
    try {
      setPatch(
        await window.honeybee.getPatch({
          schemaVersion: 1,
          runId: selectedRunId,
          patchArtifactId,
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
      setNotice("Patch " + result.disposition);
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
      const executorNote = result.requiresResume ? " · resume required to process request" : "";
      setNotice(action + " " + result.disposition + executorNote);
      setRunDetail(await window.honeybee.runDetail(request));
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setDetailBusy(undefined);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Hexagon size={34} weight="duotone" />
          </span>
          <strong>HoneyBee</strong>
        </div>
        <button
          className="primary wide"
          onClick={() => {
            setEditingProfileId(undefined);
            setView("setup");
          }}
          disabled={busy !== undefined}
        >
          <Plus size={17} weight="bold" /> Add Unity project
        </button>
        <nav className="main-nav" aria-label="Workspace views">
          <button
            className={view === "projects" ? "selected" : ""}
            onClick={() => setView("projects")}
          >
            <Folders size={20} weight="duotone" /> Projects
          </button>
          <button
            className={view === "command" ? "selected" : ""}
            onClick={() => setView("command")}
          >
            <SquaresFour size={20} weight="duotone" /> Command Center
          </button>
          <button className={view === "work" ? "selected" : ""} onClick={() => setView("work")}>
            <ListChecks size={20} weight="duotone" /> New Work
          </button>
          <button
            className={view === "history" ? "selected" : ""}
            onClick={() => setView("history")}
          >
            <ClockCounterClockwise size={20} weight="duotone" /> Run History
          </button>
        </nav>
        <div className="sidebar-heading">
          <span>Recent projects</span>
          <span>{bootstrap?.profiles.length ?? 0}</span>
        </div>
        <nav className="project-list" aria-label="Recent projects">
          {bootstrap?.profiles.map((profile) => (
            <button
              className={`project-card ${profile.profileId === selectedProfileId ? "selected" : ""}`}
              key={profile.profileId}
              onClick={() => {
                activateProfile(profile.profileId);
                setView("command");
              }}
            >
              <span className="project-glyph">
                <Cube size={17} weight="duotone" />
              </span>
              <span className="project-copy">
                <strong>{profile.label}</strong>
                <small>{profile.configLabel}</small>
              </span>
              <span
                className="remove-profile"
                role="button"
                tabIndex={0}
                aria-label={`Remove ${profile.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeProfile(profile);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") void removeProfile(profile);
                }}
              >
                <X size={14} weight="bold" />
              </span>
            </button>
          ))}
        </nav>
        <div className="runtime-foot">
          <Pulse size={16} weight="fill" />
          <span>
            HoneyBee Daemon: <strong>Connected</strong>
          </span>
          <small>
            Runtime {bootstrap?.runtime.runtimeVersion ?? "…"} · API v
            {bootstrap?.runtime.apiVersion ?? "…"}
          </small>
        </div>
      </aside>

      <main className="desktop-main">
        <header className="topbar">
          <div className="project-switcher">
            <Cube size={17} weight="duotone" />
            {bootstrap !== undefined && bootstrap.profiles.length > 0 ? (
              <select
                aria-label="Selected Unity project"
                value={selectedProfileId}
                onChange={(event) => activateProfile(event.target.value)}
              >
                {bootstrap.profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.label} · {profile.configLabel}
                  </option>
                ))}
              </select>
            ) : (
              <button
                onClick={() => {
                  setEditingProfileId(undefined);
                  setView("setup");
                }}
              >
                Add Unity project
              </button>
            )}
          </div>
          <span className="runtime-chip">
            <Pulse size={13} weight="fill" /> HoneyBee {bootstrap?.runtime.runtimeVersion ?? "…"}
          </span>
          <div className="topbar-actions">
            {selectedProfile !== undefined && (
              <>
                <button
                  className="topbar-button"
                  onClick={() => {
                    setEditingProfileId(selectedProfile.profileId);
                    setView("setup");
                  }}
                  disabled={busy !== undefined}
                >
                  <Gear size={17} /> Project Settings
                </button>
                <button
                  className="topbar-button"
                  onClick={() => void runDoctor()}
                  disabled={busy !== undefined}
                >
                  <Stethoscope size={17} /> {busy === "doctor" ? "Checking…" : "Doctor"}
                </button>
              </>
            )}
            <span className="avatar">HB</span>
          </div>
        </header>

        <div className="page-heading">
          <div>
            <h1>
              {view === "projects"
                ? "Projects"
                : view === "command"
                  ? "Command Center"
                  : view === "history"
                    ? "Run History"
                    : view === "setup"
                      ? "Setup Center"
                      : (selectedProfile?.label ?? "Choose a Unity project")}
            </h1>
            <p>
              {view === "projects"
                ? "Choose a Unity project or add an existing project to HoneyBee."
                : view === "command"
                  ? "Orchestrate AI agents. Isolate workspaces. Deliver verified changes."
                  : view === "history"
                    ? "Inspect durable outcomes, Evidence, and verified patches."
                    : view === "setup"
                      ? "Create and recover a strict local managed Unity environment."
                      : "Describe focused changes and launch a bounded parallel batch."}
            </p>
          </div>
        </div>

        {view === "projects" ? (
          <section className="projects-home">
            <div className="projects-toolbar panel">
              <div>
                <span className="eyebrow">RECENT PROJECTS</span>
                <h2>Your Unity projects</h2>
                <p>Environment setup appears once when a project is added.</p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setEditingProfileId(undefined);
                  setView("setup");
                }}
              >
                <Plus size={17} weight="bold" /> Add project
              </button>
            </div>
            {bootstrap?.profiles.length === 0 ? (
              <div className="panel runtime-empty">
                <Folders size={38} weight="duotone" />
                <h2>Add your first Unity project</h2>
                <p>
                  HoneyBee will detect Unity and your Agent, then prepare isolation automatically.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setEditingProfileId(undefined);
                    setView("setup");
                  }}
                >
                  Choose project
                </button>
              </div>
            ) : (
              <div className="projects-grid">
                {bootstrap?.profiles.map((profile) => (
                  <article className="project-tile panel" key={profile.profileId}>
                    <span className="project-glyph">
                      <Cube size={22} weight="duotone" />
                    </span>
                    <div>
                      <h3>{profile.label}</h3>
                      <p title={profile.projectPath}>{profile.projectPath}</p>
                      <small>
                        {profile.schemaVersion === 3
                          ? "Ready · managed environment"
                          : profile.configLabel}
                      </small>
                    </div>
                    <div className="project-tile-actions">
                      <button
                        className="primary"
                        onClick={() => {
                          activateProfile(profile.profileId);
                          setView("command");
                        }}
                      >
                        Open Command Center
                      </button>
                      <button
                        className="secondary"
                        onClick={() => {
                          activateProfile(profile.profileId);
                          setEditingProfileId(profile.profileId);
                          setView("setup");
                        }}
                      >
                        Project Settings
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : view === "setup" ? (
          <SetupCenter
            key={editingProfileId ?? "new-project"}
            {...(() => {
              const initialProfile = bootstrap?.profiles.find(
                (profile) => profile.profileId === editingProfileId,
              );
              return initialProfile === undefined ? {} : { initialProfile };
            })()}
            onComplete={(profile) => void completeSetup(profile)}
            onError={(message) => setError(message)}
          />
        ) : view === "work" ? (
          <div className="content-grid">
            <section className="composer panel">
              <div className="section-title">
                <div>
                  <span className="eyebrow">NEW BATCH</span>
                  <h2>What should the agents change?</h2>
                </div>
                <span className="batch-count">
                  {works.length} Work{works.length === 1 ? "" : "s"}
                </span>
              </div>

              {selectedProfile === undefined ? (
                <div className="empty-state">
                  <span>01</span>
                  <h3>Prepare a managed Unity environment</h3>
                  <p>
                    Setup Center detects local tools, pins their identity, and provisions the
                    reusable workspace parent.
                  </p>
                  <button className="primary" onClick={() => setView("setup")}>
                    Open Setup Center
                  </button>
                </div>
              ) : (
                <>
                  <div className="binding-row">
                    <label>
                      <small>Agent configuration</small>
                      <select
                        value={selectedProfile.profileId}
                        onChange={(event) => {
                          activateProfile(event.target.value);
                        }}
                      >
                        {agentProfiles.map((profile) => (
                          <option key={profile.profileId} value={profile.profileId}>
                            {profile.configLabel}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div>
                      <small>Project source</small>
                      <strong title={selectedProfile.projectPath}>
                        {selectedProfile.projectPath}
                      </strong>
                    </div>
                  </div>
                  <div className="work-list">
                    {works.map((work, index) => (
                      <article className="work-card" key={work.key}>
                        <div className="work-card-head">
                          <span>WORK {String(index + 1).padStart(2, "0")}</span>
                          {works.length > 1 && (
                            <button
                              className="text-button"
                              onClick={() =>
                                setWorks((current) =>
                                  current.filter((item) => item.key !== work.key),
                                )
                              }
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        <label>
                          <span>Task</span>
                          <textarea
                            value={work.task}
                            onChange={(event) => updateWork(work.key, { task: event.target.value })}
                            placeholder="Describe one focused Unity change in natural language…"
                            rows={4}
                          />
                        </label>
                        <div className="work-options">
                          <label>
                            <span>Priority</span>
                            <select
                              value={work.priority}
                              onChange={(event) =>
                                updateWork(work.key, {
                                  priority: event.target.value as WorkDraft["priority"],
                                })
                              }
                            >
                              <option value="interactive">Interactive</option>
                              <option value="validation">Validation</option>
                              <option value="background">Background</option>
                            </select>
                          </label>
                          <div className="capabilities">
                            <span>Capabilities</span>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={work.compile}
                                disabled={!testplayAvailable}
                                onChange={(event) =>
                                  updateWork(work.key, { compile: event.target.checked })
                                }
                              />{" "}
                              Compile
                            </label>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={work.warmTest}
                                disabled={!testplayAvailable}
                                onChange={(event) =>
                                  updateWork(work.key, { warmTest: event.target.checked })
                                }
                              />{" "}
                              Warm test
                            </label>
                          </div>
                        </div>
                        {work.warmTest && (
                          <label>
                            <span>
                              Test filter <em>optional</em>
                            </span>
                            <input
                              value={work.filter}
                              onChange={(event) =>
                                updateWork(work.key, { filter: event.target.value })
                              }
                              placeholder="Assembly, category, or test name"
                            />
                          </label>
                        )}
                      </article>
                    ))}
                  </div>
                  <div className="composer-actions">
                    <button
                      className="secondary"
                      onClick={() =>
                        setWorks((current) => [
                          ...current,
                          initialWork(Math.max(...current.map((work) => work.key)) + 1),
                        ])
                      }
                    >
                      <Plus size={16} weight="bold" /> Add parallel Work
                    </button>
                    <button
                      className="primary run-button"
                      onClick={() => void startWorks()}
                      disabled={busy !== undefined || !validWorks || doctor?.ok !== true}
                    >
                      {busy === "start"
                        ? "Starting…"
                        : `Run ${works.length === 1 ? "Work" : "batch"}`}
                    </button>
                  </div>
                  {doctor?.ok !== true && (
                    <p className="hint">Run Doctor successfully before starting work.</p>
                  )}
                </>
              )}
            </section>

            <aside className="doctor panel">
              <div className="section-title compact">
                <div>
                  <span className="eyebrow">ENVIRONMENT</span>
                  <h2>Doctor</h2>
                </div>
                {doctor !== undefined && (
                  <span className={`health ${doctor.ok ? "good" : "bad"}`}>
                    {doctor.ok ? "READY" : "ACTION NEEDED"}
                  </span>
                )}
              </div>
              {doctor === undefined ? (
                <div className="doctor-empty">
                  <div className="pulse-ring">＋</div>
                  <p>
                    Verify Unity, TestPlay, workspace-storage, Agent command, and path isolation
                    before the first run.
                  </p>
                </div>
              ) : (
                <div className="check-list">
                  {doctor.checks.map((check) => (
                    <div className={`doctor-check ${check.status}`} key={check.id}>
                      <span className="check-mark">{statusMark(check.status)}</span>
                      <div>
                        <strong>{check.label}</strong>
                        <p>{check.summary}</p>
                        {check.version !== undefined && <small>{check.version}</small>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        ) : selectedProfile === undefined ? (
          <section className="panel runtime-empty">
            <span className="eyebrow">RUNTIME OBSERVATION</span>
            <h2>Choose a Unity project</h2>
            <p>
              Link an existing v0.6 batch config to inspect its Runs, Editor Pool, and observed
              Unity Editors.
            </p>
            <button className="primary" onClick={() => setView("setup")}>
              Open Setup Center
            </button>
          </section>
        ) : (
          <div className={"runtime-layout" + (selectedRunId === undefined ? "" : " with-detail")}>
            <CommandCenter
              snapshot={snapshot}
              selectedRunId={selectedRunId}
              historyOnly={view === "history"}
              composer={
                view === "command" ? (
                  <section className="surface quick-composer">
                    <div className="quick-composer-heading">
                      <div>
                        <FirstAidKit size={19} weight="duotone" />
                        <strong>What shall we build today?</strong>
                      </div>
                      <button className="text-button" onClick={() => setView("work")}>
                        Batch builder
                      </button>
                    </div>
                    <textarea
                      value={primaryWork.task}
                      onChange={(event) =>
                        updateWork(primaryWork.key, { task: event.target.value })
                      }
                      placeholder="Describe a feature, fix, or refactor…"
                      rows={2}
                    />
                    <div className="quick-composer-actions">
                      <label className="compact-select">
                        <span>Priority</span>
                        <select
                          value={primaryWork.priority}
                          onChange={(event) =>
                            updateWork(primaryWork.key, {
                              priority: event.target.value as WorkDraft["priority"],
                            })
                          }
                        >
                          <option value="interactive">Interactive</option>
                          <option value="validation">Validation</option>
                          <option value="background">Background</option>
                        </select>
                      </label>
                      <label className="capability-chip">
                        <input
                          type="checkbox"
                          checked={primaryWork.compile}
                          disabled={!testplayAvailable}
                          onChange={(event) =>
                            updateWork(primaryWork.key, { compile: event.target.checked })
                          }
                        />
                        Compile
                      </label>
                      <label className="capability-chip">
                        <input
                          type="checkbox"
                          checked={primaryWork.warmTest}
                          disabled={!testplayAvailable}
                          onChange={(event) =>
                            updateWork(primaryWork.key, { warmTest: event.target.checked })
                          }
                        />
                        Warm test
                      </label>
                      <span className="composer-spacer" />
                      {doctor?.ok !== true && (
                        <button className="doctor-required" onClick={() => void runDoctor()}>
                          <Stethoscope size={16} /> Run Doctor
                        </button>
                      )}
                      <button
                        className="primary create-work-button"
                        onClick={() => void startWorks()}
                        disabled={busy !== undefined || !validWorks || doctor?.ok !== true}
                      >
                        <Play size={16} weight="fill" />
                        {busy === "start"
                          ? "Starting…"
                          : works.length === 1
                            ? "Create Work"
                            : `Create ${works.length} Works`}
                      </button>
                    </div>
                  </section>
                ) : undefined
              }
              onSelectRun={(runId) => {
                setSelectedRunId(runId);
                setRunDetail(undefined);
                setArtifact(undefined);
                setPatch(undefined);
              }}
            />
            {selectedRunId !== undefined && (
              <RunDetailView
                detail={runDetail}
                artifact={artifact}
                patch={patch}
                busy={detailBusy}
                onReadArtifact={(artifactId) => void readArtifact(artifactId)}
                onReadPatch={(artifactId) => void readPatch(artifactId)}
                onControl={(action) => void controlRun(action)}
                onPatchControl={(action) => void controlPatch(action)}
                onClose={() => {
                  setSelectedRunId(undefined);
                  setRunDetail(undefined);
                  setArtifact(undefined);
                  setPatch(undefined);
                }}
              />
            )}
          </div>
        )}

        {error !== undefined && (
          <div className="toast error-toast">
            <strong>Could not complete the operation</strong>
            <span>{error}</span>
            <button onClick={() => setError(undefined)} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {notice !== undefined && (
          <div className="toast success-toast">
            <strong>Runtime updated</strong>
            <span>{notice}</span>
            <button onClick={() => setNotice(undefined)} aria-label="Dismiss notice">
              <X size={16} />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
