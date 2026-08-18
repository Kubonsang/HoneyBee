import type { RunSummaryV1 } from "@honeybee/control-plane-contracts";

import type { DesktopRuntimeSnapshotV1 } from "../shared/ipc.js";

interface CommandCenterProps {
  readonly snapshot?: DesktopRuntimeSnapshotV1 | undefined;
  readonly selectedRunId?: string | undefined;
  readonly historyOnly?: boolean;
  readonly onSelectRun: (runId: string) => void;
}

const shortId = (value: string): string => value.slice(0, 8);

const runVisible = (run: RunSummaryV1, historyOnly: boolean): boolean =>
  historyOnly ? run.terminal || run.status === "indeterminate" : !run.terminal;

export function CommandCenter({
  snapshot,
  selectedRunId,
  historyOnly = false,
  onSelectRun,
}: CommandCenterProps) {
  const runs = snapshot?.runs.filter((run) => runVisible(run, historyOnly)) ?? [];
  const activeSlots = snapshot?.pool.active.length ?? 0;
  const queued = snapshot?.pool.queued.length ?? 0;

  return (
    <section className="command-view">
      <div className="metric-row">
        <div className="metric-card">
          <small>{historyOnly ? "TERMINAL RUNS" : "ACTIVE RUNS"}</small>
          <strong>{runs.length}</strong>
          <span>{historyOnly ? "Durable history" : "Polling live state"}</span>
        </div>
        <div className="metric-card accent">
          <small>EDITOR POOL</small>
          <strong>
            {activeSlots}
            <em>/{snapshot?.pool.capacity ?? "–"}</em>
          </strong>
          <span>{queued === 0 ? "No Works waiting" : `${queued} waiting`}</span>
        </div>
        <div className="metric-card">
          <small>OBSERVED EDITORS</small>
          <strong>{snapshot?.editors.editors.length ?? 0}</strong>
          <span>
            {snapshot?.editors.editors.filter((editor) => editor.ownership === "honeybee").length ??
              0}{" "}
            HoneyBee-owned
          </span>
        </div>
      </div>

      {!historyOnly && snapshot !== undefined && (
        <div className="operations-grid">
          <section className="panel ops-panel">
            <div className="section-title compact">
              <div>
                <span className="eyebrow">SHARED RESOURCE</span>
                <h2>Editor Pool</h2>
              </div>
              <span className="batch-count">{snapshot.pool.poolId}</span>
            </div>
            <div className="slot-grid">
              {Array.from({ length: snapshot.pool.capacity }, (_, index) => {
                const slotId = `editor-${index + 1}`;
                const lease = snapshot.pool.active.find((active) => active.slotId === slotId);
                return (
                  <div className={`slot ${lease === undefined ? "free" : "leased"}`} key={slotId}>
                    <span className="slot-light" />
                    <div>
                      <strong>{slotId}</strong>
                      <small>
                        {lease === undefined
                          ? "Available"
                          : `${lease.ownerWorkId} · ${lease.priority}`}
                      </small>
                    </div>
                  </div>
                );
              })}
            </div>
            {snapshot.pool.queued.length > 0 && (
              <div className="queue-list">
                <span className="subheading">Priority / FIFO queue</span>
                {snapshot.pool.queued.map((ticket, index) => (
                  <div className="queue-row" key={ticket.requestId}>
                    <span>{index + 1}</span>
                    <strong>{ticket.ownerWorkId}</strong>
                    <small>{ticket.priority}</small>
                    <code>#{ticket.ticket}</code>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel ops-panel">
            <div className="section-title compact">
              <div>
                <span className="eyebrow">OS OBSERVATION</span>
                <h2>Editor Registry</h2>
              </div>
            </div>
            <div className="editor-list">
              {snapshot.editors.editors.length === 0 ? (
                <p className="quiet">No Unity Editors observed.</p>
              ) : (
                snapshot.editors.editors.map((editor) => (
                  <div className="editor-row" key={editor.editorId}>
                    <span className={`ownership ${editor.ownership}`}>{editor.ownership}</span>
                    <div>
                      <strong>PID {editor.pid}</strong>
                      <small>{editor.projectPath ?? "Project path unavailable"}</small>
                    </div>
                    <span className={`state ${editor.state}`}>{editor.state}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      <section className="panel run-board">
        <div className="section-title compact">
          <div>
            <span className="eyebrow">{historyOnly ? "RUN HISTORY" : "LIVE WORK"}</span>
            <h2>{historyOnly ? "Completed and diagnostic Runs" : "Command Center"}</h2>
          </div>
          {snapshot !== undefined && (
            <time>{new Date(snapshot.observedAt).toLocaleTimeString()}</time>
          )}
        </div>
        <div className="run-table" role="table">
          {runs.length === 0 ? (
            <div className="empty-row">
              {snapshot === undefined
                ? "Reading durable runtime state…"
                : historyOnly
                  ? "No terminal Runs for this project."
                  : "No active Work. Start a batch when you are ready."}
            </div>
          ) : (
            runs.map((run) => (
              <button
                className={`run-row ${selectedRunId === run.runId ? "selected" : ""}`}
                key={run.runId}
                onClick={() => onSelectRun(run.runId)}
              >
                <span className={`run-status ${run.status}`}>{run.status}</span>
                <span className="run-main">
                  <strong>{run.phase}</strong>
                  <small>
                    {run.workId ?? run.mode} · {shortId(run.runId)}
                  </small>
                </span>
                <span className="run-editor">{run.assignedEditor ?? "—"}</span>
                <time>
                  {run.updatedAt === undefined ? "—" : new Date(run.updatedAt).toLocaleTimeString()}
                </time>
                <span className="chevron">›</span>
              </button>
            ))
          )}
        </div>
      </section>
    </section>
  );
}
