import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  CaretDown,
  Check,
  CheckCircle,
  Circle,
  ClockCounterClockwise,
  Code,
  Cpu,
  FileCode,
  Files,
  FirstAidKit,
  HourglassMedium,
  ListBullets,
  Play,
  Plus,
  SpinnerGap,
  Stethoscope,
  TerminalWindow,
  Trash,
  Warning,
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

import type {
  DesktopAgentProfileV1,
  DesktopProjectProfile,
  DesktopRuntimeSnapshotV1,
} from "../shared/ipc.js";
import { buildLineDiff } from "./diff-lines.js";
import {
  WORK_STAGES,
  runEvidenceSummary,
  runNeedsAttention,
  runStage,
  runTitle,
} from "./workspace-model.js";

export interface WorkDraft {
  readonly key: number;
  readonly id: string;
  readonly task: string;
  readonly priority: "interactive" | "validation" | "background";
  readonly compile: boolean;
  readonly warmTest: boolean;
  readonly filter: string;
  readonly agentId: string | undefined;
  readonly unavailableAgent: string | undefined;
}

export type UtilityTab = "runs" | "pool" | "doctor" | "activity";

interface WorkspaceViewProps {
  readonly profile: DesktopProjectProfile;
  readonly snapshot?: DesktopRuntimeSnapshotV1 | undefined;
  readonly selectedRunId?: string | undefined;
  readonly detail?: RunDetailV1 | undefined;
  readonly patch?: VerifiedPatchViewV1 | undefined;
  readonly artifact?: ArtifactViewV1 | undefined;
  readonly doctor?: DoctorReportV1 | undefined;
  readonly works: readonly WorkDraft[];
  readonly agents: readonly DesktopAgentProfileV1[];
  readonly defaultAgentId?: string | undefined;
  readonly maxParallelWorks: number;
  readonly composing: boolean;
  readonly testplayAvailable: boolean;
  readonly canStart: boolean;
  readonly busy?: "profile" | "doctor" | "start" | undefined;
  readonly detailBusy?: "artifact" | RunActionV1 | PatchActionV1 | "clone" | undefined;
  readonly utilityOpen: boolean;
  readonly utilityTab: UtilityTab;
  readonly onUpdateWork: (key: number, update: Partial<WorkDraft>) => void;
  readonly onAddWork: () => void;
  readonly onRemoveWork: (key: number) => void;
  readonly onDefaultAgent: (agentId: string | undefined) => void;
  readonly onMaxParallelWorks: (value: number) => void;
  readonly onStart: () => void;
  readonly onRunDoctor: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onControlRun: (action: RunActionV1) => void;
  readonly onReadArtifact: (artifactId: string) => void;
  readonly onPatchControl: (action: PatchActionV1) => void;
  readonly onCloneRun: () => void;
  readonly onUtility: (tab: UtilityTab, open?: boolean) => void;
}

function StageRail({ detail }: { readonly detail?: RunDetailV1 | undefined }) {
  const current = runStage(detail?.summary);
  return (
    <div className="focus-stage-rail" aria-label="Work progress">
      {WORK_STAGES.map((stage, index) => {
        const complete =
          index < current || (index === current && detail?.summary.terminal === true);
        const active = index === current && !complete;
        return (
          <div
            className={`focus-stage ${complete ? "complete" : ""} ${active ? "active" : ""}`}
            key={stage}
          >
            <span className="stage-node">
              {complete ? <Check size={13} weight="bold" /> : index + 1}
            </span>
            <strong>{stage}</strong>
            {index < WORK_STAGES.length - 1 && <span className="stage-line" />}
          </div>
        );
      })}
    </div>
  );
}

function FocusHeader({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: RunDetailV1 | undefined;
}) {
  return (
    <header className={`focus-heading ${detail === undefined ? "" : "run-focus-heading"}`}>
      <div>
        {detail === undefined && <span className="eyebrow">NEW WORK</span>}
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function WorkComposer({
  profile,
  works,
  agents,
  defaultAgentId,
  maxParallelWorks,
  doctor,
  testplayAvailable,
  canStart,
  busy,
  onUpdateWork,
  onAddWork,
  onRemoveWork,
  onDefaultAgent,
  onMaxParallelWorks,
  onStart,
  onRunDoctor,
}: Pick<
  WorkspaceViewProps,
  | "profile"
  | "works"
  | "agents"
  | "defaultAgentId"
  | "maxParallelWorks"
  | "doctor"
  | "testplayAvailable"
  | "canStart"
  | "busy"
  | "onUpdateWork"
  | "onAddWork"
  | "onRemoveWork"
  | "onDefaultAgent"
  | "onMaxParallelWorks"
  | "onStart"
  | "onRunDoctor"
>) {
  return (
    <section className="focus-workspace composer-workspace">
      <FocusHeader title="What should HoneyBee change?" />
      <StageRail />
      <div className="composer-context">
        <div>
          <span>Project</span>
          <strong>{profile.label}</strong>
          <small title={profile.projectPath}>{profile.projectPath}</small>
        </div>
        <label>
          <span>Default Agent</span>
          <select
            value={defaultAgentId ?? ""}
            onChange={(event) => onDefaultAgent(event.target.value || undefined)}
          >
            <option value="">Choose a connected Agent</option>
            {agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`doctor-status ${doctor?.ok === true ? "ready" : ""}`}
          onClick={onRunDoctor}
          disabled={busy !== undefined}
        >
          {busy === "doctor" ? (
            <SpinnerGap className="spin-icon" size={17} />
          ) : doctor?.ok === true ? (
            <CheckCircle size={17} weight="fill" />
          ) : (
            <Stethoscope size={17} />
          )}
          <span>
            <strong>{doctor?.ok === true ? "Environment ready" : "Run Doctor"}</strong>
            <small>
              {doctor?.ok === true ? "All required checks passed" : "Required before launch"}
            </small>
          </span>
        </button>
      </div>

      <div className="focused-work-list">
        {works.map((work, index) => (
          <article className="focused-work" key={work.key}>
            <header>
              <div>
                <span>WORK {String(index + 1).padStart(2, "0")}</span>
                <strong>{works.length === 1 ? "Focused change" : work.id}</strong>
              </div>
              {works.length > 1 && (
                <button
                  className="icon-button danger"
                  onClick={() => onRemoveWork(work.key)}
                  aria-label={`Remove Work ${index + 1}`}
                >
                  <Trash size={16} />
                </button>
              )}
            </header>
            <label className="task-field">
              <span>Describe the result you want</span>
              <textarea
                value={work.task}
                onChange={(event) => onUpdateWork(work.key, { task: event.target.value })}
                placeholder="Describe one focused Unity change in natural language…"
                rows={works.length === 1 ? 6 : 3}
              />
            </label>
            {work.unavailableAgent !== undefined && (
              <div className="inline-warning">
                <Warning size={16} weight="fill" />
                <span>
                  <strong>{work.unavailableAgent} is no longer available.</strong>
                  Choose a connected Agent before running this cloned draft.
                </span>
              </div>
            )}
            <div className="work-control-row">
              <label>
                <span>Agent</span>
                <select
                  value={work.agentId ?? ""}
                  onChange={(event) =>
                    onUpdateWork(work.key, {
                      agentId: event.target.value || undefined,
                      unavailableAgent: undefined,
                    })
                  }
                >
                  <option value="">Use default Agent</option>
                  {agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Priority</span>
                <select
                  value={work.priority}
                  onChange={(event) =>
                    onUpdateWork(work.key, {
                      priority: event.target.value as WorkDraft["priority"],
                    })
                  }
                >
                  <option value="interactive">Interactive</option>
                  <option value="validation">Validation</option>
                  <option value="background">Background</option>
                </select>
              </label>
              <div className="capability-group">
                <span>Validation</span>
                <label className="toggle-chip">
                  <input
                    type="checkbox"
                    checked={work.compile}
                    disabled={!testplayAvailable}
                    onChange={(event) => onUpdateWork(work.key, { compile: event.target.checked })}
                  />
                  Compile
                </label>
                <label className="toggle-chip">
                  <input
                    type="checkbox"
                    checked={work.warmTest}
                    disabled={!testplayAvailable}
                    onChange={(event) => onUpdateWork(work.key, { warmTest: event.target.checked })}
                  />
                  Warm Test
                </label>
              </div>
            </div>
            {work.warmTest && (
              <label className="filter-field">
                <span>
                  Test filter <em>optional</em>
                </span>
                <input
                  value={work.filter}
                  onChange={(event) => onUpdateWork(work.key, { filter: event.target.value })}
                  placeholder="Assembly, category, or test name"
                />
              </label>
            )}
          </article>
        ))}
      </div>

      <footer className="composer-footer">
        <div className="batch-controls">
          <button className="secondary" onClick={onAddWork}>
            <Plus size={16} weight="bold" /> Add parallel Work
          </button>
          {works.length > 1 && (
            <label>
              <span>Parallel limit</span>
              <input
                type="number"
                min={1}
                max={works.length}
                value={maxParallelWorks}
                onChange={(event) => onMaxParallelWorks(Number(event.target.value))}
              />
            </label>
          )}
        </div>
        <button className="primary launch-work" onClick={onStart} disabled={!canStart}>
          {busy === "start" ? (
            <SpinnerGap className="spin-icon" size={18} />
          ) : (
            <Play size={17} weight="fill" />
          )}
          {busy === "start"
            ? "Starting…"
            : works.length === 1
              ? "Run Work"
              : `Run ${works.length} Works`}
        </button>
      </footer>
    </section>
  );
}

function ResultBanner({
  detail,
  patch,
  busy,
  onPatchControl,
  onCloneRun,
  onEvidence,
}: {
  readonly detail: RunDetailV1;
  readonly patch?: VerifiedPatchViewV1 | undefined;
  readonly busy?: WorkspaceViewProps["detailBusy"];
  readonly onPatchControl: (action: PatchActionV1) => void;
  readonly onCloneRun: () => void;
  readonly onEvidence: () => void;
}) {
  const attention = runNeedsAttention(detail.summary);
  const completed = detail.summary.status === "completed";
  return (
    <section className={`result-banner ${attention ? "attention" : ""}`}>
      <span className="result-icon">
        {attention ? (
          <Warning size={26} weight="fill" />
        ) : completed ? (
          <CheckCircle size={26} weight="fill" />
        ) : (
          <SpinnerGap className="spin-icon" size={25} />
        )}
      </span>
      <div className="result-copy">
        <h2>
          {attention
            ? "This Work needs attention"
            : completed
              ? patch === undefined
                ? "Validated Work completed"
                : "Validated and ready"
              : detail.summary.phase}
        </h2>
        <p>
          {patch === undefined
            ? runEvidenceSummary(detail)
            : `Compile ${patch.verification.compile} · Warm Test ${patch.verification.warmTest} · ${patch.files.length} files changed`}
        </p>
      </div>
      <div className="result-actions">
        {patch?.allowedActions.includes("apply") === true && (
          <button
            className="primary"
            onClick={() => onPatchControl("apply")}
            disabled={busy !== undefined}
          >
            <Check size={17} weight="bold" /> {busy === "apply" ? "Applying…" : "Apply patch"}
          </button>
        )}
        <button className="secondary" onClick={onEvidence}>
          <FirstAidKit size={17} /> Review evidence
        </button>
        {patch?.allowedActions.includes("reject") === true && (
          <button
            className="secondary danger"
            onClick={() => onPatchControl("reject")}
            disabled={busy !== undefined}
          >
            <XCircle size={17} /> {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        )}
        <button className="secondary" onClick={onCloneRun} disabled={busy !== undefined}>
          <ArrowClockwise size={17} />
          {busy === "clone" ? "Preparing…" : "Rerun"}
        </button>
      </div>
    </section>
  );
}

function UnifiedDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const rows = useMemo(() => buildLineDiff(before, after), [after, before]);
  return (
    <div className="unified-diff" role="table" aria-label="Unified file diff">
      {rows.map((row, index) => (
        <div className={`diff-line ${row.kind}`} key={`${index}-${row.kind}`}>
          <span>{row.oldLine ?? ""}</span>
          <span>{row.newLine ?? ""}</span>
          <b>{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</b>
          <code>{row.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

function PatchReview({
  detail,
  patch,
  busy,
  onPatchControl,
  onCloneRun,
  onEvidence,
}: {
  readonly detail: RunDetailV1;
  readonly patch: VerifiedPatchViewV1;
  readonly busy?: WorkspaceViewProps["detailBusy"];
  readonly onPatchControl: (action: PatchActionV1) => void;
  readonly onCloneRun: () => void;
  readonly onEvidence: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string>(patch.files[0]?.path ?? "");
  const [mode, setMode] = useState<"unified" | "split">("unified");
  useEffect(
    () => setSelectedPath(patch.files[0]?.path ?? ""),
    [patch.patch.artifactId, patch.files],
  );
  const file = patch.files.find((candidate) => candidate.path === selectedPath) ?? patch.files[0];
  const before = file?.before?.format === "text" ? (file.before.text ?? "") : undefined;
  const after = file?.after?.format === "text" ? (file.after.text ?? "") : undefined;

  return (
    <>
      <ResultBanner
        detail={detail}
        patch={patch}
        {...(busy === undefined ? {} : { busy })}
        onPatchControl={onPatchControl}
        onCloneRun={onCloneRun}
        onEvidence={onEvidence}
      />
      <section className="patch-workbench">
        <aside className="changed-files">
          <header>
            <Files size={18} />
            <strong>Changed files</strong>
            <span>{patch.files.length}</span>
          </header>
          <div>
            {patch.files.map((candidate) => (
              <button
                className={candidate.path === file?.path ? "selected" : ""}
                key={candidate.path}
                onClick={() => setSelectedPath(candidate.path)}
              >
                <FileCode size={17} />
                <span>
                  <strong>{candidate.path.split(/[\\/]/u).at(-1)}</strong>
                  <small>{candidate.path}</small>
                </span>
                <em className={candidate.operation}>{candidate.operation}</em>
              </button>
            ))}
          </div>
        </aside>
        <div className="diff-workbench">
          <header>
            <div>
              <strong>{file?.path.split(/[\\/]/u).at(-1) ?? "No changed file"}</strong>
              <small>{file?.path ?? "The verified patch does not contain files."}</small>
            </div>
            <div className="segmented-control">
              <button
                className={mode === "unified" ? "selected" : ""}
                onClick={() => setMode("unified")}
              >
                Unified
              </button>
              <button
                className={mode === "split" ? "selected" : ""}
                onClick={() => setMode("split")}
              >
                Side-by-side
              </button>
            </div>
          </header>
          {file === undefined ? (
            <div className="diff-unavailable">No file content is available.</div>
          ) : before === undefined || after === undefined ? (
            <div className="diff-unavailable">
              <Code size={28} />
              <strong>Text preview unavailable</strong>
              <p>
                This {file.operation} file is binary, truncated, or unavailable. HoneyBee preserves
                the verified metadata without rendering unsafe content.
              </p>
            </div>
          ) : mode === "unified" ? (
            <UnifiedDiff before={before} after={after} />
          ) : (
            <div className="split-diff">
              <div>
                <span>BEFORE</span>
                <pre>{before || "∅"}</pre>
              </div>
              <div>
                <span>AFTER</span>
                <pre>{after || "∅"}</pre>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function RunWorkspace({
  detail,
  patch,
  artifact,
  detailBusy,
  onControlRun,
  onReadArtifact,
  onPatchControl,
  onCloneRun,
  onUtility,
}: Pick<
  WorkspaceViewProps,
  | "detail"
  | "patch"
  | "artifact"
  | "detailBusy"
  | "onControlRun"
  | "onReadArtifact"
  | "onPatchControl"
  | "onCloneRun"
  | "onUtility"
>) {
  if (detail === undefined) {
    return (
      <section className="focus-workspace loading-workspace">
        <SpinnerGap className="spin-icon" size={25} />
        Reading durable Work state…
      </section>
    );
  }
  return (
    <section className="focus-workspace run-workspace">
      <FocusHeader title={runTitle(detail.summary)} detail={detail} />
      <StageRail detail={detail} />
      {patch !== undefined ? (
        <PatchReview
          detail={detail}
          patch={patch}
          {...(detailBusy === undefined ? {} : { busy: detailBusy })}
          onPatchControl={onPatchControl}
          onCloneRun={onCloneRun}
          onEvidence={() => onUtility("activity", true)}
        />
      ) : (
        <>
          <ResultBanner
            detail={detail}
            {...(detailBusy === undefined ? {} : { busy: detailBusy })}
            onPatchControl={onPatchControl}
            onCloneRun={onCloneRun}
            onEvidence={() => onUtility("activity", true)}
          />
          <div className="run-body-grid">
            <section className="current-step">
              <header>
                <span className="step-icon">
                  {runNeedsAttention(detail.summary) ? (
                    <Warning size={20} weight="fill" />
                  ) : detail.summary.terminal ? (
                    <CheckCircle size={20} weight="fill" />
                  ) : (
                    <SpinnerGap className="spin-icon" size={19} />
                  )}
                </span>
                <div>
                  <span>Current state</span>
                  <h2>{detail.summary.phase}</h2>
                </div>
                <span
                  className={`status-pill ${runNeedsAttention(detail.summary) ? "danger" : ""}`}
                >
                  {detail.summary.status}
                </span>
              </header>
              {detail.message !== undefined && (
                <p className="diagnostic-message">{detail.message}</p>
              )}
              {detail.failure !== undefined && (
                <div className="failure-box">
                  <Warning size={18} />
                  <div>
                    <strong>{detail.failure.errorCode}</strong>
                    <span>
                      {detail.failure.exitCode === undefined
                        ? "The durable Run recorded a failure."
                        : `Process exited with code ${detail.failure.exitCode}.`}
                    </span>
                  </div>
                </div>
              )}
              <div className="run-control-row">
                {detail.summary.allowedActions.map((action) => (
                  <button
                    className={action === "cancel" ? "secondary danger" : "primary"}
                    key={action}
                    disabled={detailBusy !== undefined}
                    onClick={() => onControlRun(action)}
                  >
                    {action === "resume" ? <Play size={16} /> : <XCircle size={16} />}
                    {detailBusy === action ? `${action}…` : action}
                  </button>
                ))}
              </div>
            </section>
            <section className="recent-events">
              <header>
                <ListBullets size={18} />
                <strong>Recent activity</strong>
                <button onClick={() => onUtility("activity", true)}>View all</button>
              </header>
              {detail.events
                .slice(-6)
                .reverse()
                .map((event) => (
                  <article key={event.sequence}>
                    <span className="event-dot" />
                    <div>
                      <strong>{event.summary}</strong>
                      <small>
                        {new Date(event.timestamp).toLocaleTimeString()} · #{event.sequence}
                      </small>
                    </div>
                  </article>
                ))}
            </section>
          </div>
          {detail.artifacts.length > 0 && (
            <section className="evidence-strip">
              <header>
                <FirstAidKit size={18} />
                <strong>Evidence & outputs</strong>
              </header>
              <div>
                {detail.artifacts.slice(0, 5).map((item) => (
                  <button
                    key={item.artifactId}
                    onClick={() => onReadArtifact(item.artifactId)}
                    disabled={detailBusy !== undefined}
                  >
                    <FileCode size={16} />
                    <span>{item.kind}</span>
                    <small>{item.byteLength.toLocaleString()} B</small>
                  </button>
                ))}
              </div>
              {artifact !== undefined && (
                <pre className="artifact-inline">
                  {artifact.encoding === "utf8"
                    ? artifact.content.slice(0, 20_000)
                    : "Binary Artifact preview is intentionally disabled."}
                </pre>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

function UtilityDrawer({
  snapshot,
  selectedRunId,
  doctor,
  open,
  tab,
  onSelectRun,
  onRunDoctor,
  onUtility,
}: Pick<
  WorkspaceViewProps,
  "snapshot" | "selectedRunId" | "doctor" | "onSelectRun" | "onRunDoctor" | "onUtility"
> & {
  readonly open: boolean;
  readonly tab: UtilityTab;
}) {
  const tabs: readonly [UtilityTab, ReactNode, string][] = [
    ["runs", <ClockCounterClockwise size={16} key="runs" />, "Runs"],
    ["pool", <Cpu size={16} key="pool" />, "Editor Pool"],
    ["doctor", <Stethoscope size={16} key="doctor" />, "Doctor"],
    ["activity", <TerminalWindow size={16} key="activity" />, "Activity"],
  ];
  return (
    <>
      <button
        className={`utility-status-bar ${open ? "open" : ""}`}
        onClick={() => onUtility(tab, !open)}
        aria-expanded={open}
      >
        <CaretDown size={16} />
        <span>Utilities</span>
        <small>runs, editor pool, queue, doctor, activity</small>
        <span className="status-spacer" />
        <i className="live-dot" />
        <strong>
          {snapshot === undefined
            ? "Connecting…"
            : `${snapshot.pool.active.length}/${snapshot.pool.capacity} Editors active`}
        </strong>
        <span>{snapshot?.pool.queued.length ?? 0} queued</span>
      </button>
      <aside className={`utility-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <header>
          <nav>
            {tabs.map(([value, icon, label]) => (
              <button
                className={tab === value ? "selected" : ""}
                key={value}
                onClick={() => onUtility(value, true)}
              >
                {icon}
                {label}
              </button>
            ))}
          </nav>
          <button
            className="icon-button"
            onClick={() => onUtility(tab, false)}
            aria-label="Close utilities"
          >
            <X size={17} />
          </button>
        </header>
        <div className="utility-content">
          {tab === "runs" && (
            <div className="utility-run-list">
              {(snapshot?.runs ?? []).length === 0 ? (
                <p className="quiet">No durable Runs are available for this project.</p>
              ) : (
                snapshot?.runs.map((run) => (
                  <button
                    className={selectedRunId === run.runId ? "selected" : ""}
                    key={run.runId}
                    onClick={() => onSelectRun(run.runId)}
                  >
                    {runNeedsAttention(run) ? (
                      <Warning size={17} weight="fill" />
                    ) : run.terminal ? (
                      <CheckCircle size={17} weight="fill" />
                    ) : (
                      <SpinnerGap className="spin-icon" size={17} />
                    )}
                    <span>
                      <strong>{runTitle(run)}</strong>
                      <small>{run.phase}</small>
                    </span>
                    <em>{run.status}</em>
                    <time>
                      {run.updatedAt === undefined
                        ? "—"
                        : new Date(run.updatedAt).toLocaleTimeString()}
                    </time>
                  </button>
                ))
              )}
            </div>
          )}
          {tab === "pool" && (
            <div className="utility-pool">
              <section>
                <h3>Editor slots</h3>
                {Array.from({ length: snapshot?.pool.capacity ?? 0 }, (_, index) => {
                  const slotId = `editor-${index + 1}`;
                  const lease = snapshot?.pool.active.find((entry) => entry.slotId === slotId);
                  return (
                    <article key={slotId}>
                      {lease === undefined ? (
                        <CheckCircle size={17} weight="fill" />
                      ) : (
                        <SpinnerGap className="spin-icon" size={17} />
                      )}
                      <span>
                        <strong>{slotId}</strong>
                        <small>{lease?.ownerWorkId ?? "Available"}</small>
                      </span>
                    </article>
                  );
                })}
              </section>
              <section>
                <h3>Queue</h3>
                {(snapshot?.pool.queued ?? []).length === 0 ? (
                  <p className="quiet">No Work is waiting for an Editor.</p>
                ) : (
                  snapshot?.pool.queued.map((ticket) => (
                    <article key={ticket.requestId}>
                      <HourglassMedium size={17} />
                      <span>
                        <strong>{ticket.ownerWorkId}</strong>
                        <small>{ticket.priority} priority</small>
                      </span>
                    </article>
                  ))
                )}
              </section>
            </div>
          )}
          {tab === "doctor" && (
            <div className="utility-doctor">
              <header>
                <div>
                  <h3>{doctor?.ok === true ? "Environment ready" : "Environment check"}</h3>
                  <p>Unity, Agent, storage, TestPlay, and isolation readiness.</p>
                </div>
                <button className="secondary" onClick={onRunDoctor}>
                  <Stethoscope size={16} /> Run Doctor
                </button>
              </header>
              {doctor === undefined ? (
                <p className="quiet">Run Doctor to inspect the current project environment.</p>
              ) : (
                <div>
                  {doctor.checks.map((check) => (
                    <article className={check.status} key={check.id}>
                      {check.status === "pass" ? (
                        <CheckCircle size={17} weight="fill" />
                      ) : check.status === "warning" ? (
                        <Warning size={17} weight="fill" />
                      ) : (
                        <XCircle size={17} weight="fill" />
                      )}
                      <span>
                        <strong>{check.label}</strong>
                        <small>{check.summary}</small>
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === "activity" && (
            <div className="utility-activity">
              {(snapshot?.runs ?? []).flatMap((run) =>
                run.updatedAt === undefined
                  ? []
                  : [
                      <article key={run.runId}>
                        <time>{new Date(run.updatedAt).toLocaleTimeString()}</time>
                        <Circle size={9} weight="fill" />
                        <span>
                          <strong>{runTitle(run)}</strong>
                          {run.phase}
                        </span>
                      </article>,
                    ],
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

export function WorkspaceView(props: WorkspaceViewProps) {
  return (
    <>
      {props.composing || props.selectedRunId === undefined ? (
        <WorkComposer {...props} />
      ) : (
        <RunWorkspace {...props} />
      )}
      <UtilityDrawer
        snapshot={props.snapshot}
        selectedRunId={props.selectedRunId}
        doctor={props.doctor}
        open={props.utilityOpen}
        tab={props.utilityTab}
        onSelectRun={props.onSelectRun}
        onRunDoctor={props.onRunDoctor}
        onUtility={props.onUtility}
      />
    </>
  );
}
