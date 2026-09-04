import { CaretRight, Cube, FolderOpen } from "@phosphor-icons/react";

import type { DesktopProjectCandidateV1 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";

const statusKey = (status: DesktopProjectCandidateV1["setupState"]): MessageKey =>
  status === "ready" ? "connected" : status === "setup-required" ? "setupRequired" : status;

export function ProjectPicker({
  candidates,
  onChoose,
  onBrowse,
  t,
}: {
  candidates: readonly DesktopProjectCandidateV1[];
  onChoose: (candidate: DesktopProjectCandidateV1) => void;
  onBrowse: () => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <section className="content-screen screen-pad narrow-screen" data-testid="project-picker">
      <div className="section-heading">
        <div>
          <p className="eyebrow">HONEYBEE WORKBENCH</p>
          <h1>{t("projects")}</h1>
        </div>
        <button className="secondary" onClick={onBrowse}>
          <FolderOpen size={18} />
          {t("manualFolder")}
        </button>
      </div>
      <div className="project-list">
        {candidates.map((candidate) => (
          <button
            key={candidate.path}
            className="project-row"
            disabled={candidate.setupState === "unavailable" || candidate.setupState === "invalid"}
            onClick={() => onChoose(candidate)}
          >
            <Cube size={26} weight="duotone" />
            <span className="project-copy">
              <strong>{candidate.label}</strong>
              <small>{candidate.path}</small>
            </span>
            {candidate.unityVersion !== null && (
              <small className="unity-version">Unity {candidate.unityVersion}</small>
            )}
            <span className={`status-chip ${candidate.setupState}`}>
              {t(statusKey(candidate.setupState))}
            </span>
            <CaretRight size={20} />
          </button>
        ))}
      </div>
    </section>
  );
}
