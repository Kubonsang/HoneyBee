import { useEffect, useMemo, useState } from "react";

import type {
  ArtifactViewV1,
  DoctorReportV1,
  RunActionV1,
  RunDetailV1,
} from "@honeybee/control-plane-contracts";

import {
  DesktopStartRequestV1Schema,
  type DesktopBootstrapV1,
  type DesktopProjectProfileV1,
  type DesktopRuntimeSnapshotV1,
} from "../shared/ipc.js";
import { CommandCenter } from "./CommandCenter.js";
import { RunDetailView } from "./RunDetailView.js";

type DesktopView = "command" | "work" | "history";

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
  compile: true,
  warmTest: true,
  filter: "",
});

const readableError = (error: unknown): string =>
  error instanceof Error ? error.message : "HoneyBee operation failed.";

const statusMark = (status: "pass" | "warning" | "fail"): string =>
  status === "pass" ? "✓" : status === "warning" ? "!" : "×";

export function App() {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapV1>();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [view, setView] = useState<DesktopView>("command");
  const [doctor, setDoctor] = useState<DoctorReportV1>();
  const [works, setWorks] = useState<readonly WorkDraft[]>([initialWork()]);
  const [busy, setBusy] = useState<"profile" | "doctor" | "start">();
  const [detailBusy, setDetailBusy] = useState<"artifact" | RunActionV1>();
  const [snapshot, setSnapshot] = useState<DesktopRuntimeSnapshotV1>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [runDetail, setRunDetail] = useState<RunDetailV1>();
  const [artifact, setArtifact] = useState<ArtifactViewV1>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    void window.honeybee
      .bootstrap()
      .then((value) => {
        setBootstrap(value);
        setSelectedProfileId(value.profiles[0]?.profileId);
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
  const validWorks = works.every(
    (work) => work.task.trim().length > 0 && (work.compile || work.warmTest),
  );

  const activateProfile = (profileId: string | undefined): void => {
    setSelectedProfileId(profileId);
    setDoctor(undefined);
    setSnapshot(undefined);
    setSelectedRunId(undefined);
    setRunDetail(undefined);
    setArtifact(undefined);
  };

  const chooseProfile = async (): Promise<void> => {
    setBusy("profile");
    setError(undefined);
    try {
      const profile = await window.honeybee.chooseProfile();
      if (profile === null) return;
      const value = await window.honeybee.bootstrap();
      setBootstrap(value);
      activateProfile(profile.profileId);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const removeProfile = async (profile: DesktopProjectProfileV1): Promise<void> => {
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
          <span className="brand-mark">HB</span>
          <div>
            <strong>HoneyBee</strong>
            <small>Unity control plane</small>
          </div>
        </div>
        <button
          className="primary wide"
          onClick={() => void chooseProfile()}
          disabled={busy !== undefined}
        >
          + Add Unity project
        </button>
        <nav className="main-nav" aria-label="Workspace views">
          <button
            className={view === "command" ? "selected" : ""}
            onClick={() => setView("command")}
          >
            <span>⌁</span> Command Center
          </button>
          <button className={view === "work" ? "selected" : ""} onClick={() => setView("work")}>
            <span>＋</span> New Work
          </button>
          <button
            className={view === "history" ? "selected" : ""}
            onClick={() => setView("history")}
          >
            <span>◷</span> Run History
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
              }}
            >
              <span className="project-glyph">U</span>
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
                ×
              </span>
            </button>
          ))}
        </nav>
        <div className="runtime-foot">
          <span className="live-dot" /> Runtime {bootstrap?.runtime.runtimeVersion ?? "…"}
          <small>API v{bootstrap?.runtime.apiVersion ?? "…"}</small>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">DESKTOP MVP</span>
            <h1>
              {view === "command"
                ? "Command Center"
                : view === "history"
                  ? "Run History"
                  : (selectedProfile?.label ?? "Choose a Unity project")}
            </h1>
          </div>
          {view === "work" && selectedProfile !== undefined && (
            <button
              className="secondary"
              onClick={() => void runDoctor()}
              disabled={busy !== undefined}
            >
              {busy === "doctor" ? "Checking…" : "Run environment Doctor"}
            </button>
          )}
        </header>

        {view === "work" ? (
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
                  <h3>Link an existing v0.6 config</h3>
                  <p>
                    Select the Unity project and its HoneyBee batch config. No setup wizard or
                    duplicate runtime config is created.
                  </p>
                  <button className="primary" onClick={() => void chooseProfile()}>
                    Choose project
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
                      + Add parallel Work
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
            <button className="primary" onClick={() => void chooseProfile()}>
              Choose project
            </button>
          </section>
        ) : (
          <div className={"runtime-layout" + (selectedRunId === undefined ? "" : " with-detail")}>
            <CommandCenter
              snapshot={snapshot}
              selectedRunId={selectedRunId}
              historyOnly={view === "history"}
              onSelectRun={(runId) => {
                setSelectedRunId(runId);
                setRunDetail(undefined);
                setArtifact(undefined);
              }}
            />
            {selectedRunId !== undefined && (
              <RunDetailView
                detail={runDetail}
                artifact={artifact}
                busy={detailBusy}
                onReadArtifact={(artifactId) => void readArtifact(artifactId)}
                onControl={(action) => void controlRun(action)}
                onClose={() => {
                  setSelectedRunId(undefined);
                  setRunDetail(undefined);
                  setArtifact(undefined);
                }}
              />
            )}
          </div>
        )}

        {error !== undefined && (
          <div className="toast error-toast">
            <strong>Could not complete the operation</strong>
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>×</button>
          </div>
        )}
        {notice !== undefined && (
          <div className="toast success-toast">
            <strong>Runtime updated</strong>
            <span>{notice}</span>
            <button onClick={() => setNotice(undefined)}>×</button>
          </div>
        )}
      </main>
    </div>
  );
}
