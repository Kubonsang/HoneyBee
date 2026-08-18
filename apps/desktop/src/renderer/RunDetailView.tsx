import type { ArtifactViewV1, RunActionV1, RunDetailV1 } from "@honeybee/control-plane-contracts";

interface RunDetailViewProps {
  readonly detail?: RunDetailV1 | undefined;
  readonly artifact?: ArtifactViewV1 | undefined;
  readonly busy?: "artifact" | RunActionV1 | undefined;
  readonly onReadArtifact: (artifactId: string) => void;
  readonly onControl: (action: RunActionV1) => void;
  readonly onClose: () => void;
}

const MAX_RENDERED_ARTIFACT_CHARS = 200_000;

const artifactText = (artifact: ArtifactViewV1): string => {
  if (artifact.encoding === "base64") return "Binary Artifact; preview is intentionally disabled.";
  if (artifact.content.length > MAX_RENDERED_ARTIFACT_CHARS) {
    return `${artifact.content.slice(0, MAX_RENDERED_ARTIFACT_CHARS)}\n\n… preview truncated …`;
  }
  if (artifact.artifact.mediaType !== "application/json") return artifact.content;
  try {
    return JSON.stringify(JSON.parse(artifact.content), null, 2);
  } catch {
    return artifact.content;
  }
};

export function RunDetailView({
  detail,
  artifact,
  busy,
  onReadArtifact,
  onControl,
  onClose,
}: RunDetailViewProps) {
  if (detail === undefined) {
    return (
      <aside className="detail-drawer panel loading-detail">
        <span className="spinner" /> Reading Journal…
      </aside>
    );
  }
  const evidence = detail.artifacts.filter((item) =>
    [
      "unity-capability-evidence",
      "testplay-evidence",
      "step-content",
      "unity-verified-patch",
    ].includes(item.kind),
  );
  return (
    <aside className="detail-drawer panel">
      <div className="detail-head">
        <div>
          <span className="eyebrow">RUN DETAIL</span>
          <h2>{detail.summary.phase}</h2>
          <code>{detail.summary.runId}</code>
        </div>
        <button className="close-detail" onClick={onClose} aria-label="Close Run detail">
          ×
        </button>
      </div>
      <div className="detail-facts">
        <div>
          <small>Status</small>
          <strong>{detail.summary.status}</strong>
        </div>
        <div>
          <small>Mode</small>
          <strong>{detail.summary.mode}</strong>
        </div>
        <div>
          <small>Editor</small>
          <strong>{detail.summary.assignedEditor ?? "Unassigned"}</strong>
        </div>
      </div>
      {detail.message !== undefined && <p className="diagnostic-message">{detail.message}</p>}
      {detail.failure !== undefined && (
        <div className="failure-box">
          <small>FAILURE</small>
          <strong>{detail.failure.errorCode}</strong>
          {detail.failure.exitCode !== undefined && <span>Exit {detail.failure.exitCode}</span>}
        </div>
      )}
      {detail.summary.allowedActions.length > 0 && (
        <div className="control-row">
          {detail.summary.allowedActions.map((action) => (
            <button
              className={action === "cancel" ? "danger-button" : "primary"}
              disabled={busy !== undefined}
              key={action}
              onClick={() => onControl(action)}
            >
              {busy === action ? `${action}…` : action}
            </button>
          ))}
        </div>
      )}

      <section className="detail-section">
        <span className="subheading">Agent & capability activity</span>
        <div className="timeline">
          {detail.events.map((event) => (
            <div className="timeline-event" key={event.sequence}>
              <span className="timeline-dot" />
              <div>
                <strong>{event.summary}</strong>
                <small>
                  #{event.sequence} · {new Date(event.timestamp).toLocaleTimeString()}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="detail-section">
        <span className="subheading">Evidence & outputs</span>
        {evidence.length === 0 ? (
          <p className="quiet">No readable Evidence Artifact is referenced yet.</p>
        ) : (
          <div className="artifact-list">
            {evidence.map((item) => (
              <button
                key={item.artifactId}
                disabled={busy !== undefined}
                onClick={() => onReadArtifact(item.artifactId)}
              >
                <span>{item.kind}</span>
                <small>
                  {item.mediaType} · {item.byteLength.toLocaleString()} B
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      {artifact !== undefined && (
        <section className="artifact-preview">
          <div>
            <strong>{artifact.artifact.kind}</strong>
            <small>{artifact.artifact.contentDigest}</small>
          </div>
          <pre>{artifactText(artifact)}</pre>
        </section>
      )}
    </aside>
  );
}
