import type { ReactNode } from "react";
import {
  CheckCircle,
  Circle,
  ClockCountdown,
  Cpu,
  HardDrives,
  HourglassMedium,
  ShieldCheck,
  SpinnerGap,
  Pulse,
  WarningCircle,
} from "@phosphor-icons/react";

import type { RunSummaryV1 } from "@honeybee/control-plane-contracts";

import type { DesktopRuntimeSnapshotV1 } from "../shared/ipc.js";

interface CommandCenterProps {
  readonly snapshot?: DesktopRuntimeSnapshotV1 | undefined;
  readonly selectedRunId?: string | undefined;
  readonly historyOnly?: boolean;
  readonly composer?: ReactNode;
  readonly onSelectRun: (runId: string) => void;
}

const stages = ["Prepare", "Agent", "Compile", "Test", "Verify"] as const;
const shortId = (value: string): string => value.slice(0, 8);
const runVisible = (run: RunSummaryV1, historyOnly: boolean): boolean =>
  historyOnly ? run.terminal || run.status === "indeterminate" : !run.terminal;

const runProgress = (run: RunSummaryV1): number => {
  if (run.terminal && run.status === "completed") return stages.length;
  const phase = run.phase.toLowerCase();
  if (phase.includes("release") || phase.includes("evidence") || phase.includes("verify")) return 4;
  if (phase.includes("test") || phase.includes("warm")) return 3;
  if (phase.includes("compile")) return 2;
  if (phase.includes("agent") || phase.includes("work")) return 1;
  return 0;
};

const runTone = (run: RunSummaryV1): "running" | "waiting" | "success" | "danger" => {
  if (run.status === "completed") return "success";
  if (
    run.status.includes("failed") ||
    run.status.includes("indeterminate") ||
    run.status.includes("cleanup")
  ) {
    return "danger";
  }
  if (run.phase.toLowerCase().includes("wait") || run.assignedEditor === undefined)
    return "waiting";
  return "running";
};

const displayWork = (run: RunSummaryV1): string =>
  run.workId === undefined ? run.mode.replaceAll("-", " ") : `Work ${run.workId}`;

function WorkProgress({ run }: { readonly run: RunSummaryV1 }) {
  const current = runProgress(run);
  return (
    <div className="work-progress" aria-label={`Current phase: ${run.phase}`}>
      {stages.map((stage, index) => {
        const completed = index < current;
        const active = index === current && current < stages.length;
        return (
          <div
            className={`progress-step ${completed ? "complete" : ""} ${active ? "active" : ""}`}
            key={stage}
          >
            <span className="progress-track" aria-hidden="true" />
            {completed ? (
              <CheckCircle size={18} weight="fill" />
            ) : active ? (
              <SpinnerGap className="spin-icon" size={18} weight="bold" />
            ) : (
              <Circle size={18} weight="fill" />
            )}
            <small>{stage}</small>
          </div>
        );
      })}
    </div>
  );
}

function RunCard({
  run,
  selected,
  onSelect,
}: {
  readonly run: RunSummaryV1;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const tone = runTone(run);
  return (
    <button className={`work-run-card ${tone} ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="work-monogram">{(run.workId ?? run.mode).slice(-1).toUpperCase()}</span>
      <span className="work-run-main">
        <span className="work-run-heading">
          <strong>{displayWork(run)}</strong>
          <span className={`run-pill ${tone}`}>{run.status}</span>
        </span>
        <span className="work-run-meta">
          <span>{run.priority ?? run.mode}</span>
          <span>{shortId(run.runId)}</span>
          <span>{run.phase}</span>
        </span>
        <WorkProgress run={run} />
      </span>
      <span className="work-run-aside">
        <small>Editor</small>
        <strong>{run.assignedEditor ?? "Waiting"}</strong>
        <small>Updated</small>
        <time>
          {run.updatedAt === undefined ? "—" : new Date(run.updatedAt).toLocaleTimeString()}
        </time>
      </span>
    </button>
  );
}

function Metric({
  icon,
  value,
  label,
  tone = "neutral",
}: {
  readonly icon: ReactNode;
  readonly value: string | number;
  readonly label: string;
  readonly tone?: "neutral" | "green" | "amber";
}) {
  return (
    <div className={`dashboard-metric ${tone}`}>
      <span className="metric-icon">{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

export function CommandCenter({
  snapshot,
  selectedRunId,
  historyOnly = false,
  composer,
  onSelectRun,
}: CommandCenterProps) {
  const runs = snapshot?.runs.filter((run) => runVisible(run, historyOnly)) ?? [];
  const activeRuns = snapshot?.runs.filter((run) => !run.terminal) ?? [];
  const completedRuns = snapshot?.runs.filter((run) => run.status === "completed") ?? [];
  const residualRuns =
    snapshot?.runs.filter(
      (run) => run.status.includes("cleanup") || run.status === "indeterminate",
    ) ?? [];
  const activeSlots = snapshot?.pool.active.length ?? 0;
  const queued = snapshot?.pool.queued.length ?? 0;
  const recentlyCompleted = completedRuns.slice(0, 4);
  const activityRuns = [...(snapshot?.runs ?? [])]
    .filter((run) => run.updatedAt !== undefined)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, 7);

  if (historyOnly) {
    return (
      <section className="command-view history-view">
        <div className="dashboard-metrics">
          <Metric
            icon={<ShieldCheck size={21} />}
            value={completedRuns.length}
            label="Verified Runs"
            tone="green"
          />
          <Metric
            icon={<WarningCircle size={21} />}
            value={residualRuns.length}
            label="Needs Attention"
            tone={residualRuns.length === 0 ? "green" : "amber"}
          />
          <Metric
            icon={<HardDrives size={21} />}
            value={snapshot?.runs.length ?? 0}
            label="Durable Runs"
          />
          <Metric
            icon={<ClockCountdown size={21} />}
            value={
              snapshot === undefined ? "—" : new Date(snapshot.observedAt).toLocaleTimeString()
            }
            label="Last Observed"
          />
        </div>
        <section className="surface run-board">
          <div className="dashboard-section-head">
            <div>
              <h2>Run History</h2>
              <p>Completed, failed, and diagnostic runs for this project.</p>
            </div>
          </div>
          <div className="work-run-list">
            {runs.length === 0 ? (
              <div className="empty-row">
                {snapshot === undefined
                  ? "Reading durable runtime state…"
                  : "No terminal Runs yet."}
              </div>
            ) : (
              runs.map((run) => (
                <RunCard
                  key={run.runId}
                  run={run}
                  selected={selectedRunId === run.runId}
                  onSelect={() => onSelectRun(run.runId)}
                />
              ))
            )}
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="command-view">
      <div className="dashboard-metrics">
        <Metric icon={<Pulse size={21} />} value={activeRuns.length} label="Active Works" />
        <Metric
          icon={<Cpu size={21} />}
          value={`${activeSlots}/${snapshot?.pool.capacity ?? "—"}`}
          label="Editors In Use"
        />
        <Metric
          icon={<ShieldCheck size={21} />}
          value={completedRuns.length}
          label="Verified Runs"
        />
        <Metric
          icon={residualRuns.length === 0 ? <CheckCircle size={21} /> : <WarningCircle size={21} />}
          value={residualRuns.length}
          label="Residuals"
          tone={residualRuns.length === 0 ? "green" : "amber"}
        />
      </div>

      <div className="command-columns">
        <div className="command-primary-column">
          {composer}
          <section className="active-works-section">
            <div className="dashboard-section-head">
              <div>
                <h2>Active Works</h2>
                <p>Durable agent and capability progress.</p>
              </div>
              <span className="count-badge">{runs.length}</span>
            </div>
            <div className="work-run-list">
              {runs.length === 0 ? (
                <div className="surface empty-run-state">
                  {snapshot === undefined ? (
                    <>
                      <SpinnerGap className="spin-icon" size={24} /> Reading runtime state…
                    </>
                  ) : (
                    <>
                      <CheckCircle size={24} weight="duotone" /> No active Work. The Editor Pool is
                      ready.
                    </>
                  )}
                </div>
              ) : (
                runs.map((run) => (
                  <RunCard
                    key={run.runId}
                    run={run}
                    selected={selectedRunId === run.runId}
                    onSelect={() => onSelectRun(run.runId)}
                  />
                ))
              )}
            </div>
          </section>

          {recentlyCompleted.length > 0 && (
            <section className="recent-section">
              <div className="dashboard-section-head compact">
                <h2>Recently Completed</h2>
              </div>
              <div className="recent-list">
                {recentlyCompleted.map((run) => (
                  <button key={run.runId} onClick={() => onSelectRun(run.runId)}>
                    <CheckCircle size={17} weight="fill" />
                    <strong>{displayWork(run)}</strong>
                    <span>{run.workId ?? run.mode}</span>
                    <time>
                      {run.updatedAt === undefined
                        ? "—"
                        : new Date(run.updatedAt).toLocaleTimeString()}
                    </time>
                    <span className="verified-badge">Verified</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="command-side-column">
          <section className="surface editor-pool-card">
            <div className="dashboard-section-head compact">
              <div>
                <h2>Editor Pool</h2>
                <p>{snapshot?.pool.poolId ?? "Waiting for runtime"}</p>
              </div>
              <span className="count-badge">
                {activeSlots}/{snapshot?.pool.capacity ?? "—"}
              </span>
            </div>
            <div className="editor-slot-list">
              {snapshot === undefined ? (
                <div className="quiet-card">Reading Editor Pool…</div>
              ) : (
                Array.from({ length: snapshot.pool.capacity }, (_, index) => {
                  const slotId = `editor-${index + 1}`;
                  const lease = snapshot.pool.active.find((item) => item.slotId === slotId);
                  const editor = snapshot.editors.editors.find((item) => item.slotId === slotId);
                  return (
                    <article
                      className={`editor-slot-card ${lease === undefined ? "free" : "leased"}`}
                      key={slotId}
                    >
                      <div className="editor-slot-heading">
                        {lease === undefined ? (
                          <CheckCircle size={16} weight="fill" />
                        ) : (
                          <SpinnerGap className="spin-icon" size={16} weight="bold" />
                        )}
                        <strong>{slotId}</strong>
                        <span>{lease === undefined ? "Available" : "In Use"}</span>
                      </div>
                      <div className="editor-slot-body">
                        <small>
                          {editor === undefined
                            ? (lease?.ownerWorkId ?? "Ready for Work")
                            : `${editor.ownership} · PID ${editor.pid}`}
                        </small>
                        <strong>{lease?.ownerWorkId ?? "Idle"}</strong>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            {queued > 0 && (
              <div className="editor-queue">
                <div className="queue-heading">
                  <strong>Queue</strong>
                  <span className="count-badge">{queued}</span>
                </div>
                {snapshot?.pool.queued.map((ticket) => (
                  <div className="queue-item" key={ticket.requestId}>
                    <HourglassMedium size={17} />
                    <div>
                      <strong>{ticket.ownerWorkId}</strong>
                      <small>
                        {ticket.priority} · ticket {ticket.ticket}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="surface activity-card">
            <div className="dashboard-section-head compact">
              <div>
                <h2>System Activity</h2>
                <p>Latest durable Run observations.</p>
              </div>
              <span className="live-label">
                <Circle size={9} weight="fill" /> Live
              </span>
            </div>
            <div className="activity-list">
              {activityRuns.length === 0 ? (
                <p className="quiet">No activity recorded yet.</p>
              ) : (
                activityRuns.map((run) => {
                  const tone = runTone(run);
                  return (
                    <button key={run.runId} onClick={() => onSelectRun(run.runId)}>
                      <time>{new Date(run.updatedAt ?? "").toLocaleTimeString()}</time>
                      {tone === "success" ? (
                        <CheckCircle size={15} weight="fill" />
                      ) : tone === "danger" ? (
                        <WarningCircle size={15} weight="fill" />
                      ) : (
                        <SpinnerGap className={tone === "running" ? "spin-icon" : ""} size={15} />
                      )}
                      <span>
                        {displayWork(run)} · {run.phase}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
