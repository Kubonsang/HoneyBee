import { FolderSimple, GitBranch } from "@phosphor-icons/react";

import type { MessageKey } from "../i18n.js";

export function ProjectHome({
  onHub,
  onClone,
  t,
}: {
  onHub: () => void;
  onClone: () => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <section className="home-screen screen-pad" data-testid="project-home">
      <div className="home-logo">
        <img src="./honeybee.png" alt="HoneyBee" />
        <h1>HoneyBee</h1>
        <p>{t("homeTitle")}</p>
      </div>
      <div className="entry-grid">
        <button className="entry-card" onClick={onHub}>
          <FolderSimple size={48} weight="duotone" />
          <span>
            <strong>{t("unityHub")}</strong>
            <small>{t("unityHubHelp")}</small>
          </span>
        </button>
        <button className="entry-card" onClick={onClone}>
          <GitBranch size={48} weight="duotone" />
          <span>
            <strong>{t("gitClone")}</strong>
            <small>{t("gitCloneHelp")}</small>
          </span>
        </button>
      </div>
    </section>
  );
}
