import { GitBranch, X } from "@phosphor-icons/react";
import { useState } from "react";

import type { DesktopWorkspaceCreateRequestV1 } from "../../shared/ipc.js";
import type { MessageKey } from "../i18n.js";

export function WorkspaceDialog({
  projectId,
  busy,
  onClose,
  onCreate,
  t,
}: {
  projectId: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (request: DesktopWorkspaceCreateRequestV1) => void;
  t: (key: MessageKey) => string;
}) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [attach, setAttach] = useState(false);
  const submit = (): void => {
    if (name.trim() === "" || branch.trim() === "") return;
    onCreate({
      projectId,
      name: name.trim(),
      branch: branch.trim(),
      ...(base.trim() === "" || attach ? {} : { base: base.trim() }),
      existingBranch: attach,
    });
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
        data-testid="workspace-dialog"
      >
        <header>
          <div>
            <p className="eyebrow">GIT WORKTREE + LIBRARY COW</p>
            <h2 id="workspace-dialog-title">{t("newWorkspace")}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <label className="field">
          <span>{t("name")}</span>
          <input
            autoFocus
            value={name}
            placeholder="combat"
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              if (!attach) setBranch(value === "" ? "" : `feature/${value}`);
            }}
          />
        </label>
        <label className="field">
          <span>{t("branch")}</span>
          <div className="input-with-icon">
            <GitBranch size={18} />
            <input
              value={branch}
              placeholder="feature/combat"
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
        </label>
        {!attach && (
          <label className="field">
            <span>{t("base")}</span>
            <input
              value={base}
              placeholder="main"
              onChange={(event) => setBase(event.target.value)}
            />
          </label>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={attach}
            onChange={(event) => setAttach(event.target.checked)}
          />
          {t("attach")}
        </label>
        <footer>
          <button className="secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="primary"
            disabled={busy || name.trim() === "" || branch.trim() === ""}
            onClick={submit}
          >
            {attach ? t("attach") : t("create")}
          </button>
        </footer>
      </section>
    </div>
  );
}
