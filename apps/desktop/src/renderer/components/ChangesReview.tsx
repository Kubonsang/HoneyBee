import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseGitStatusLine } from "@honeybee/core/git-status";
import type { DesktopGitDiffV1, DesktopWorkspaceV2 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import { changeGroup, changeGroups, diffLines } from "../change-review.js";
import { LatestRequest } from "../latest-request.js";
import { errorGuidance, operationError, type OperationError } from "../operation-errors.js";
import type { MessageKey } from "../i18n.js";

export function ChangesReview({
  projectId,
  workspace,
  refreshedAt,
  t,
}: {
  projectId: string;
  workspace: DesktopWorkspaceV2;
  refreshedAt: number | undefined;
  t: (key: MessageKey) => string;
}) {
  const changes = useMemo(
    () => (workspace.git?.changes ?? []).map(parseGitStatusLine),
    [workspace.git],
  );
  const [selected, setSelected] = useState<string | undefined>(() => changes[0]?.path);
  const [query, setQuery] = useState("");
  const [diff, setDiff] = useState<DesktopGitDiffV1>();
  const [error, setError] = useState<OperationError>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const requests = useRef(new LatestRequest());
  const view = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; left: number }>());
  const [scrollTop, setScrollTop] = useState(0);
  const selectionKey = selected ?? "\0all";
  const loadedKey = useRef<string | undefined>(undefined);
  const statusKey = workspace.git?.changes.join("\0");
  const gitKnown = workspace.git !== null;
  useEffect(() => {
    if (selected !== undefined && !changes.some((change) => change.path === selected))
      setSelected(undefined);
  }, [changes, selected]);
  useEffect(() => {
    const isCurrent = requests.current.begin();
    if (!gitKnown) {
      setDiff(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    if (loadedKey.current !== selectionKey) setDiff(undefined);
    setLoading(true);
    setError(undefined);
    void desktopApi
      .gitDiff({
        projectId,
        workspaceId: workspace.workspaceId,
        ...(selected === undefined ? {} : { path: selected }),
      })
      .then((result) => {
        if (isCurrent()) {
          loadedKey.current = selectionKey;
          setDiff(result);
        }
      })
      .catch((reason) => {
        if (isCurrent()) setError(operationError(reason));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const current = requests.current;
    return () => current.invalidate();
  }, [
    projectId,
    workspace.workspaceId,
    selected,
    selectionKey,
    statusKey,
    gitKnown,
    refreshedAt,
    retry,
  ]);
  const lines = useMemo(() => diffLines(diff?.content ?? "", diff?.kind === "untracked"), [diff]);
  useLayoutEffect(() => {
    const position = positions.current.get(selectionKey) ?? { top: 0, left: 0 };
    if (view.current) {
      view.current.scrollTop = position.top;
      view.current.scrollLeft = position.left;
      setScrollTop(view.current.scrollTop);
    }
  }, [selectionKey, diff]);
  // Bound DOM size independently of the 1 MiB streamed patch limit.
  const firstLine = Math.max(0, Math.floor(scrollTop / 22) - 12);
  const visibleLines = lines.slice(firstLine, firstLine + 180);
  const choose = (file?: string) => {
    if (view.current)
      positions.current.set(selectionKey, {
        top: view.current.scrollTop,
        left: view.current.scrollLeft,
      });
    setSelected(file);
  };
  const visibleChanges = changes.filter((change) =>
    change.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="changes-review" data-testid="changes-review">
      <aside className="changed-files">
        <input
          className="change-search"
          type="search"
          aria-label={t("searchChanges")}
          placeholder={t("searchChanges")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className={selected === undefined ? "selected" : ""}
          aria-pressed={selected === undefined}
          disabled={!gitKnown}
          onClick={() => choose()}
        >
          {t("allChanges")} <small>{changes.length}</small>
        </button>
        {changeGroups.map((group) => {
          const entries = visibleChanges.filter((change) => changeGroup(change.path) === group);
          return entries.length === 0 ? null : (
            <section className="change-group" key={group}>
              <h3>
                {t(group)} <small>{entries.length}</small>
              </h3>
              {entries.map((change) => (
                <button
                  key={change.path}
                  className={selected === change.path ? "selected" : ""}
                  aria-pressed={selected === change.path}
                  title={
                    change.originalPath === undefined
                      ? change.path
                      : `${change.originalPath} → ${change.path}`
                  }
                  onClick={() => choose(change.path)}
                >
                  <code>{change.status}</code>
                  <span>{change.path}</span>
                </button>
              ))}
            </section>
          );
        })}
        {!gitKnown ? (
          <p>{t("gitUnknown")}</p>
        ) : changes.length === 0 ? (
          <p>{t("clean")}</p>
        ) : visibleChanges.length === 0 ? (
          <p>{t("noMatchingFiles")}</p>
        ) : null}
        <p className="change-classification-help">{t("classificationHelp")}</p>
      </aside>
      <section className="diff-panel">
        <header className="diff-toolbar">
          <strong title={selected}>{selected ?? t("allChanges")}</strong>
          <button disabled={loading || !gitKnown} onClick={() => setRetry((value) => value + 1)}>
            {t("refresh")}
          </button>
        </header>
        <small className="diff-context">
          {diff?.kind === "untracked" ? t("untrackedPreview") : t("diffBaseline")}
          {loading ? ` · ${t("diffLoading")}` : ""}
        </small>
        {error && (
          <div className="diff-error" role="alert">
            <p>{t(errorGuidance(error.code, error.upstreamCode))}</p>
            <details>
              <summary>{t("diagnosticDetails")}</summary>
              <code>{error.code}</code>
              <p>{error.message}</p>
            </details>
            <button onClick={() => setRetry((value) => value + 1)}>{t("retry")}</button>
          </div>
        )}
        <div
          className="diff-view"
          ref={view}
          tabIndex={0}
          aria-label={t("diff")}
          onScroll={(event) => {
            const target = event.currentTarget;
            if (loadedKey.current === selectionKey && diff !== undefined)
              positions.current.set(selectionKey, {
                top: target.scrollTop,
                left: target.scrollLeft,
              });
            setScrollTop(target.scrollTop);
          }}
        >
          {!gitKnown ? (
            <p>{t("gitUnknown")}</p>
          ) : diff?.kind === "binary" ? (
            <p>{t("binaryDiff")}</p>
          ) : lines.length ? (
            <div className="diff-lines">
              <div style={{ height: firstLine * 22 }} aria-hidden="true" />
              {visibleLines.map((line, index) => (
                <div className={`diff-line ${line.kind}`} key={firstLine + index}>
                  <span className="line-number">{line.oldLine ?? ""}</span>
                  <span className="line-number">{line.newLine ?? ""}</span>
                  <code>{line.text}</code>
                </div>
              ))}
              <div
                style={{ height: Math.max(0, lines.length - firstLine - visibleLines.length) * 22 }}
                aria-hidden="true"
              />
            </div>
          ) : loading ? (
            <p>{t("diffLoading")}</p>
          ) : error ? null : (
            <p>
              {diff?.kind === "untracked"
                ? t("emptyFile")
                : changes.length === 0
                  ? t("clean")
                  : t("emptyCombinedDiff")}
            </p>
          )}
        </div>
        {diff?.truncated && <p className="diff-notice">{t("diffTruncated")}</p>}
        {selected === undefined && changes.some((change) => change.untracked) && (
          <p className="diff-notice">{t("selectUntrackedPreview")}</p>
        )}
      </section>
    </section>
  );
}
