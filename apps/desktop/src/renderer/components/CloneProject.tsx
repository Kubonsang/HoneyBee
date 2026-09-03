import { FolderOpen, GitBranch } from "@phosphor-icons/react";
import { useState } from "react";

import type { MessageKey } from "../i18n.js";

export function CloneProject({
  busy,
  onBrowse,
  onClone,
  t,
}: {
  busy: boolean;
  onBrowse: (suggestedName: string | undefined) => Promise<string | null>;
  onClone: (url: string, destination: string) => void;
  t: (key: MessageKey) => string;
}) {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const suggestedName = (): string | undefined => {
    const tail = url
      .trim()
      .split(/[/:]/u)
      .at(-1)
      ?.replace(/\.git$/u, "");
    return tail === undefined || tail === "" ? undefined : tail;
  };
  return (
    <section className="content-screen screen-pad form-screen">
      <div className="form-hero">
        <GitBranch size={42} weight="duotone" />
        <div>
          <p className="eyebrow">ONE-TIME ONBOARDING</p>
          <h1>{t("gitClone")}</h1>
          <p>{t("gitCloneHelp")}</p>
        </div>
      </div>
      <label className="field">
        <span>{t("cloneUrl")}</span>
        <input
          autoFocus
          value={url}
          placeholder="https://github.com/team/game.git"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("cloneDestination")}</span>
        <div className="input-action">
          <input
            value={destination}
            placeholder="C:\\Unity\\Game"
            onChange={(event) => setDestination(event.target.value)}
          />
          <button
            className="icon-button"
            disabled={url.trim() === ""}
            onClick={() =>
              void onBrowse(suggestedName()).then((value) => {
                if (value !== null) setDestination(value);
              })
            }
          >
            <FolderOpen size={19} />
          </button>
        </div>
      </label>
      <button
        className="primary full-button"
        disabled={busy || url.trim() === "" || destination.trim() === ""}
        onClick={() => onClone(url.trim(), destination.trim())}
      >
        {busy && <span className="spinner" />}
        {busy ? t("cloning") : t("clone")}
      </button>
      <p className="form-note">{t("cloneNote")}</p>
    </section>
  );
}
