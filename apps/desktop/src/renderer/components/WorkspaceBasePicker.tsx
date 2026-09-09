import { useEffect, useRef, useState } from "react";

import type {
  DesktopBaseCommitV1,
  DesktopBaseHistoryV1,
  DesktopBaseRefsV1,
} from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { MessageKey } from "../i18n.js";

export function WorkspaceBasePicker({
  projectId,
  onChange,
  t,
}: {
  projectId: string;
  onChange: (commit: DesktopBaseCommitV1 | undefined) => void;
  t: (key: MessageKey) => string;
}) {
  const [refs, setRefs] = useState<DesktopBaseRefsV1>();
  const [refsOffset, setRefsOffset] = useState(0);
  const [refsLoading, setRefsLoading] = useState(true);
  const [refsError, setRefsError] = useState(false);
  const [query, setQuery] = useState<{ reference: string; offset: number }>();
  const [history, setHistory] = useState<DesktopBaseHistoryV1>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [selected, setSelected] = useState<DesktopBaseCommitV1>();
  const [source, setSource] = useState("HEAD");
  const [sourceLabel, setSourceLabel] = useState("");
  const [retry, setRetry] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [input, setInput] = useState("");
  const [resolvedInput, setResolvedInput] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(false);
  const resolveGeneration = useRef(0);
  const initialHead = useRef<DesktopBaseCommitV1 | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setRefsLoading(true);
    setRefsError(false);
    void desktopApi
      .workspaceBaseRefs({ projectId, offset: refsOffset })
      .then((result) => {
        if (!active) return;
        setRefs(result);
        if (initialHead.current === undefined) {
          initialHead.current = result.head;
          setSourceLabel(result.currentBranch ?? "HEAD");
          setQuery({ reference: result.head.commit, offset: 0 });
        }
      })
      .catch(() => {
        if (active) setRefsError(true);
      })
      .finally(() => {
        if (active) setRefsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, refsOffset, retry]);

  useEffect(() => {
    if (query === undefined) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError(false);
    void desktopApi
      .workspaceBaseHistory({ projectId, ...query })
      .then((result) => {
        if (!active) return;
        setHistory(result);
        setSelected((current) => current ?? result.commits[0]);
      })
      .catch(() => {
        if (active) setHistoryError(true);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, query, retry]);

  useEffect(
    () => () => {
      resolveGeneration.current++;
    },
    [],
  );

  const loading = refsLoading || historyLoading || resolving;
  const failed = refsError || historyError || resolveError;
  const valid = !loading && !failed && (!advanced || resolvedInput === input.trim());
  useEffect(() => {
    onChange(valid ? selected : undefined);
  }, [valid, selected, onChange]);

  const chooseSource = (reference: string, label: string): void => {
    onChange(undefined);
    setSelected(undefined);
    setHistory(undefined);
    setSource(reference);
    setSourceLabel(label);
    setHistoryLoading(true);
    setQuery({
      reference: reference === "HEAD" ? (initialHead.current?.commit ?? "HEAD") : reference,
      offset: 0,
    });
  };
  const resolveInput = (): void => {
    const generation = ++resolveGeneration.current;
    const reference = input.trim();
    onChange(undefined);
    setResolving(true);
    setResolveError(false);
    void desktopApi
      .resolveWorkspaceBase({ projectId, reference })
      .then((result) => {
        if (generation !== resolveGeneration.current) return;
        setSelected(result);
        setResolvedInput(reference);
        setSourceLabel(reference);
      })
      .catch(() => {
        if (generation === resolveGeneration.current) setResolveError(true);
      })
      .finally(() => {
        if (generation === resolveGeneration.current) setResolving(false);
      });
  };
  const date = (value: string): string =>
    new Date(value).toLocaleString(t("baseLocale"), { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="base-picker" aria-busy={loading}>
      <label className="field">
        <span>{t("base")}</span>
        <select
          data-testid="base-source"
          value={source}
          disabled={advanced || refsLoading}
          onChange={(event) => {
            const reference = event.target.value;
            chooseSource(
              reference,
              refs?.refs.find((item) => item.reference === reference)?.label ??
                refs?.currentBranch ??
                "HEAD",
            );
          }}
        >
          <option value="HEAD">
            {t("baseCurrent")} · {refs?.currentBranch ?? "HEAD"}
          </option>
          {source !== "HEAD" && !refs?.refs.some((item) => item.reference === source) && (
            <option value={source}>{sourceLabel}</option>
          )}
          {(["branch", "remote", "tag"] as const).map((kind) => (
            <optgroup
              key={kind}
              label={t(
                kind === "branch" ? "baseBranches" : kind === "remote" ? "baseRemotes" : "baseTags",
              )}
            >
              {refs?.refs
                .filter((item) => item.kind === kind)
                .map((item) => (
                  <option key={item.reference} value={item.reference}>
                    {item.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {(refsOffset > 0 || (refs?.nextOffset !== null && refs?.nextOffset !== undefined)) && (
        <div className="base-pages">
          <button
            type="button"
            className="secondary"
            disabled={refsLoading || refsOffset === 0}
            onClick={() => setRefsOffset(Math.max(0, refsOffset - 100))}
          >
            {t("basePreviousRefs")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={refsLoading || refs?.nextOffset == null}
            onClick={() => {
              if (refs?.nextOffset != null) setRefsOffset(refs.nextOffset);
            }}
          >
            {t("baseNextRefs")}
          </button>
        </div>
      )}
      <p className="base-hint">{t("baseLocalHint")}</p>
      {!advanced && (
        <>
          <div className="base-commits" role="group" aria-label={t("baseHistory")}>
            {!historyLoading &&
              history?.commits.map((commit) => (
                <label
                  className={`base-commit${selected?.commit === commit.commit ? " selected" : ""}`}
                  key={commit.commit}
                >
                  <input
                    type="radio"
                    name="base-commit"
                    value={commit.commit}
                    checked={selected?.commit === commit.commit}
                    onChange={() => setSelected(commit)}
                  />
                  <span>
                    <strong>{commit.subject || t("baseUntitled")}</strong>
                    <small>
                      {commit.author} · {date(commit.authoredAt)} · {commit.commit.slice(0, 8)}
                    </small>
                  </span>
                </label>
              ))}
          </div>
          <div className="base-pages">
            <button
              type="button"
              className="secondary"
              disabled={historyLoading || !query || query.offset === 0}
              onClick={() => {
                if (history && query) {
                  onChange(undefined);
                  setHistoryLoading(true);
                  setQuery({ reference: history.tip, offset: Math.max(0, query.offset - 50) });
                }
              }}
            >
              {t("baseNewer")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={historyLoading || history?.nextOffset == null}
              onClick={() => {
                if (history?.nextOffset != null) {
                  onChange(undefined);
                  setHistoryLoading(true);
                  setQuery({ reference: history.tip, offset: history.nextOffset });
                }
              }}
            >
              {t("baseOlder")}
            </button>
          </div>
        </>
      )}
      <details
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setAdvanced(open);
          setResolveError(false);
          setResolvedInput(undefined);
          resolveGeneration.current++;
          setResolving(false);
          onChange(undefined);
          if (!open) chooseSource(source, sourceLabel);
        }}
      >
        <summary>{t("baseAdvanced")}</summary>
        <label className="field">
          <span>{t("baseReference")}</span>
          <input
            data-testid="base-input"
            value={input}
            maxLength={255}
            onChange={(event) => {
              setInput(event.target.value);
              setResolvedInput(undefined);
              setResolveError(false);
              setResolving(false);
              resolveGeneration.current++;
              onChange(undefined);
            }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={input.trim() === "" || loading}
          onClick={resolveInput}
        >
          {t("baseResolve")}
        </button>
      </details>
      {loading && <p role="status">{t("baseLoading")}</p>}
      {failed && (
        <div role="alert">
          <p>{t(resolveError ? "baseInvalid" : "baseLoadFailed")}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (resolveError) resolveInput();
              else setRetry((value) => value + 1);
            }}
          >
            {t("baseRetry")}
          </button>
        </div>
      )}
      {valid && selected && (
        <p className="base-summary" data-testid="base-summary">
          <strong>
            {t("baseSelected")}: {selected.subject || t("baseUntitled")}
          </strong>
          <br />
          {selected.author} · {date(selected.authoredAt)} · {selected.commit.slice(0, 8)}
        </p>
      )}
    </div>
  );
}
