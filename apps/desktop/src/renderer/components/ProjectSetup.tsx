import {
  CheckCircle,
  Database,
  FolderOpen,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { DesktopDoctorReportV1, DesktopProjectInspectionV1 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";

const CheckIcon = ({ status }: { status: "pass" | "warning" | "fail" }) =>
  status === "pass" ? (
    <CheckCircle className="check-pass" size={22} weight="fill" />
  ) : status === "warning" ? (
    <WarningCircle className="check-warning" size={22} weight="fill" />
  ) : (
    <XCircle className="check-fail" size={22} weight="fill" />
  );

export function ProjectSetup({
  inspection,
  doctor,
  workspaceRoot,
  setWorkspaceRoot,
  busy,
  cacheReady,
  onBrowseRoot,
  onCheck,
  onOpenUnity,
  onSetup,
  t,
}: {
  inspection: DesktopProjectInspectionV1;
  doctor: DesktopDoctorReportV1 | undefined;
  workspaceRoot: string;
  setWorkspaceRoot: (value: string) => void;
  busy: boolean;
  cacheReady: boolean;
  onBrowseRoot: () => void;
  onCheck: () => void;
  onOpenUnity: () => void;
  onSetup: () => void;
  t: (key: MessageKey) => string;
}) {
  const storageChecks = doctor?.checks.filter((item) => item.code.startsWith("storage.")) ?? [];
  const storageReady =
    storageChecks.length > 0 && storageChecks.every((item) => item.status !== "fail");
  const sourceMissing = inspection.checks.some(
    (item) => item.code === "cache.source-library" && item.status !== "pass",
  );
  const canSetup = inspection.readyForSetup && storageReady;
  return (
    <section
      className="content-screen screen-pad narrow-screen setup-screen"
      data-testid="project-setup"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">UNITY WORKSPACE PROVIDER</p>
          <h1>{t("projectSetup")}</h1>
        </div>
        <button className="secondary" disabled={busy} onClick={onCheck}>
          {t("checkAgain")}
        </button>
      </div>
      <div className="selected-project">
        <Database size={28} weight="duotone" />
        <div>
          <strong>{inspection.label}</strong>
          <small>{inspection.path}</small>
          <small>
            {inspection.unityVersion === null
              ? t("unityUnknown")
              : `Unity ${inspection.unityVersion}`}
          </small>
        </div>
      </div>
      <label className="field">
        <span>{t("workspaceRoot")}</span>
        <div className="input-action">
          <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} />
          <button className="icon-button" onClick={onBrowseRoot}>
            <FolderOpen size={19} />
          </button>
        </div>
      </label>
      <div className="setup-checks">
        {inspection.checks.map((item) => {
          const title =
            item.code === "cache.source-library"
              ? t("sourceLibrary")
              : item.code === "cache.library-ignored"
                ? t("libraryIgnored")
                : item.code === "project.unity-layout"
                  ? t("unityProject")
                  : t("gitRepository");
          const detail =
            item.code === "cache.source-library"
              ? t(item.status === "pass" ? "libraryPresent" : "libraryMissing")
              : item.code === "cache.library-ignored"
                ? t(item.status === "pass" ? "libraryIgnoredYes" : "libraryIgnoredNo")
                : item.code === "project.unity-layout"
                  ? t(item.status === "pass" ? "unityValid" : "unityInvalid")
                  : t(item.status === "pass" ? "gitValid" : "gitInvalid");
          return (
            <div className="setup-check" key={item.code}>
              <CheckIcon status={item.status} />
              <div>
                <strong>{title}</strong>
                <small>{detail}</small>
              </div>
            </div>
          );
        })}
        <div className="setup-check">
          <CheckIcon status={storageReady ? "pass" : "fail"} />
          <div>
            <strong>{t("storageReady")}</strong>
            <small>{t(storageReady ? "storageValid" : "storageInvalid")}</small>
          </div>
        </div>
        <div className="setup-check">
          <CheckIcon status={cacheReady ? "pass" : "warning"} />
          <div>
            <strong>{t("cacheReady")}</strong>
            <small>{t(cacheReady ? "cachePrepared" : "cacheMissing")}</small>
          </div>
        </div>
      </div>
      {sourceMissing && (
        <button className="secondary full-button" onClick={onOpenUnity}>
          <ShieldCheck size={19} />
          {t("openUnity")}
        </button>
      )}
      <button
        className="primary full-button"
        disabled={busy || !canSetup || workspaceRoot.trim() === ""}
        onClick={onSetup}
      >
        {busy && <span className="spinner" />}
        {busy ? t("preparing") : cacheReady ? t("refresh") : t("setupProject")}
      </button>
      {!canSetup && <p className="form-note">{t("setupBlockedNote")}</p>}
      {cacheReady && <p className="warning-note">{t("refreshWarning")}</p>}
    </section>
  );
}
