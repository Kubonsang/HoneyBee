import { useEffect, useRef, useState } from "react";
import type { DesktopWorkspaceUsageV1 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { MessageKey } from "../i18n.js";

export function WorkspaceUsage({
  projectId,
  workspaceId,
  t,
}: {
  projectId: string;
  workspaceId: string;
  t: (key: MessageKey) => string;
}) {
  const [report, setReport] = useState<DesktopWorkspaceUsageV1>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const measure = async (): Promise<void> => {
    const request = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await desktopApi.workspaceUsage({ projectId, workspaceId });
      if (request === generation.current) setReport(result);
    } catch (reason) {
      if (request === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  const format = (bytes: number | null): string =>
    bytes === null
      ? t("usageUnknown")
      : `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  const labels: Record<string, MessageKey> = {
    files: "usageFiles",
    "testplay-local": "usageLocalCache",
    "child-vhdx": "usageChild",
    "parent-vhdx": "usageParent",
    "external-bee": "usageBee",
    "bee-seed": "usageBeeSeed",
    "testplay-shared": "usageSharedCache",
  };
  return (
    <section className="usage-panel" data-testid="workspace-usage">
      <div className="usage-toolbar">
        <h3>{t("usageTitle")}</h3>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void measure();
          }}
        >
          {busy ? t("checking") : t("usageMeasure")}
        </button>
      </div>
      <p>{t("usageHelp")}</p>
      {error !== undefined && <p role="alert">{error}</p>}
      {report !== undefined && (
        <>
          <p role="status">
            {new Date(report.measuredAt).toLocaleString()} ·{" "}
            {report.complete ? t("usageComplete") : t("usagePartial")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("usageTitle")}</th>
                <th>{t("usageAllocated")}</th>
                <th>{t("usageLogical")}</th>
              </tr>
            </thead>
            <tbody>
              {report.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {t(labels[entry.kind] ?? "usageFiles")}
                    {entry.scope === "shared" && <small> · {t("usageShared")}</small>}
                    {!entry.complete && <small> · {t("usagePartial")}</small>}
                  </td>
                  <td>{format(entry.allocatedBytes)}</td>
                  <td>{format(entry.logicalBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <strong>
              {t("usageKnownTotal")}: {format(report.knownAllocatedBytes)}
            </strong>
          </p>
          {report.entries.some((entry) => entry.errors.length > 0) && (
            <details>
              <summary>{t("diagnosticDetails")}</summary>
              {report.entries
                .filter((entry) => entry.errors.length > 0)
                .map((entry) => (
                  <pre key={entry.id}>{entry.errors.join("\n")}</pre>
                ))}
            </details>
          )}
        </>
      )}
      <p>{t("usageCleanupHelp")}</p>
      <code>
        testplay cache usage --json
        <br />
        testplay cache prune --dry-run
      </code>
    </section>
  );
}
