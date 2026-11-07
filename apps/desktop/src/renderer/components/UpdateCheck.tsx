import { useEffect, useRef, useState } from "react";
import type { DesktopUpdateStatusV1, DesktopRecoveryOperationV2 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { Locale } from "../i18n.js";
import { recoveryElapsed } from "../recovery-copy.js";

const text = {
  ko: {
    check: "업데이트 확인",
    checking: "업데이트 확인 중…",
    cancel: "취소",
    current: "최신 버전입니다.",
    unavailable: "이 빌드에서는 앱 내 업데이트를 사용할 수 없습니다.",
    failed: "업데이트를 처리하지 못했습니다. 다시 시도해 주세요.",
    available: "새 버전",
    close: "닫기",
    download: "다운로드",
    downloading: "업데이트 다운로드 중…",
    downloaded: "다운로드와 파일 검증이 완료됐습니다. 아직 설치하지 않았습니다.",
    preparing: "업데이트 준비 중…",
    apply: "업데이트 및 재시작",
    applying: "업데이트 적용 중… 잠시 후 다시 시작합니다.",
    updated: "업데이트가 완료됐습니다.",
    rolledBack: "이전 버전으로 복구했습니다.",
    unresolved: "업데이트 결과를 아직 확인할 수 없습니다. 작업 기록은 보존되어 있습니다.",
    updateCancelled: "업데이트가 취소됐습니다. 현재 버전을 계속 사용할 수 있습니다.",
    prepared: "업데이트 준비가 완료됐습니다. 아직 새 버전으로 전환하지 않았습니다.",
  },
  en: {
    check: "Check for updates",
    checking: "Checking for updates…",
    cancel: "Cancel",
    current: "You are up to date.",
    unavailable: "In-app updates are unavailable in this build.",
    failed: "Could not process the update. Please try again.",
    available: "New version",
    close: "Close",
    download: "Download",
    downloading: "Downloading update…",
    downloaded: "Download verified. The update has not been installed.",
    preparing: "Preparing update…",
    apply: "Update & Restart",
    applying: "Applying update… HoneyBee will restart shortly.",
    updated: "Update complete.",
    rolledBack: "The previous version was restored.",
    unresolved: "The update result is not yet available. Its records have been preserved.",
    updateCancelled: "The update was cancelled. You can continue using the current version.",
    prepared: "Update prepared. The new version has not been activated.",
  },
};
export function UpdateCheck({ locale, onRecovery }: { locale: Locale; onRecovery?: () => void }) {
  const [status, setStatus] = useState<DesktopUpdateStatusV1>();
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<DesktopRecoveryOperationV2>();
  const [now, setNow] = useState(Date.now());
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const sequence = useRef(0);
  const t = text[locale];
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const next = await desktopApi.updateOperation();
        if (!stopped) {
          setOperation(next);
          setNow(Date.now());
        }
      } catch {
        /* The v1 controls remain usable if detail retrieval fails. */
      }
      if (!stopped)
        timer = setTimeout(() => {
          void refresh();
        }, 1000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open]);
  useEffect(() => {
    let cancelled = false;
    const current = sequence.current;
    void desktopApi
      .updateStatus()
      .then((next) => {
        if (!cancelled && sequence.current === current) {
          setStatus(next);
          if (
            ["Updated", "RolledBack", "Failed", "Unresolved", "UpdateCancelled"].includes(
              next.state,
            )
          )
            setOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (
      status?.state !== "Checking" &&
      status?.state !== "Downloading" &&
      status?.state !== "Preparing" &&
      status?.state !== "Applying" &&
      status?.state !== "Unresolved"
    )
      return;
    let cancelled = false;
    let polls = 0;
    const timer = window.setInterval(() => {
      if (status?.state === "Unresolved" && ++polls >= 30) window.clearInterval(timer);
      const current = sequence.current;
      void desktopApi
        .updateStatus()
        .then((next) => {
          if (!cancelled && sequence.current === current) setStatus(next);
        })
        .catch(() => {
          if (!cancelled && sequence.current === current)
            setStatus({ schemaVersion: 1, state: "Failed", version: null, mandatory: false });
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.state]);
  const request = async (
    action: "check" | "cancel" | "download" | "apply" = "check",
  ): Promise<void> => {
    const current = ++sequence.current;
    setOpen(true);
    try {
      const next = await (action === "apply"
        ? desktopApi.applyUpdate()
        : action === "cancel"
          ? desktopApi.cancelUpdateCheck()
          : action === "download"
            ? desktopApi.downloadUpdate()
            : desktopApi.checkUpdate());
      if (current === sequence.current) setStatus(next);
    } catch {
      if (current === sequence.current)
        setStatus({ schemaVersion: 1, state: "Failed", version: null, mandatory: false });
    }
  };
  const checking = status?.state === "Checking";
  const downloading = status?.state === "Downloading";
  const preparing = status?.state === "Preparing";
  const applying = status?.state === "Applying";
  const busy = checking || downloading || preparing || applying;
  const elapsed = recoveryElapsed(operation?.startedAt ?? null, now);
  const sinceProgress = recoveryElapsed(operation?.lastProgressAt ?? null, now);
  const exportDiagnostics = async (): Promise<void> => {
    try {
      if (await desktopApi.exportRecoveryDiagnostics())
        setDiagnosticMessage(locale === "ko" ? "진단 파일을 저장했습니다." : "Diagnostics saved.");
    } catch {
      setDiagnosticMessage(
        locale === "ko" ? "진단 파일을 저장하지 못했습니다." : "Could not save diagnostics.",
      );
    }
  };
  const message =
    status?.state === "Unresolved"
      ? t.unresolved
      : status?.state === "UpdateCancelled"
        ? t.updateCancelled
        : applying
          ? t.applying
          : status?.state === "Updated"
            ? t.updated
            : status?.state === "RolledBack"
              ? t.rolledBack
              : preparing
                ? t.preparing
                : status?.state === "Prepared"
                  ? t.prepared
                  : downloading
                    ? t.downloading
                    : status?.state === "Downloaded"
                      ? t.downloaded
                      : status?.state === "Available"
                        ? `${t.available}: ${status.version}`
                        : status?.state === "UpToDate"
                          ? t.current
                          : status?.state === "Unavailable"
                            ? t.unavailable
                            : status?.state === "Failed"
                              ? t.failed
                              : checking
                                ? t.checking
                                : t.check;
  return (
    <div className="update-check">
      <button
        className="locale-button"
        onClick={() => (busy || status?.state === "Prepared" ? setOpen(true) : void request())}
        disabled={checking}
      >
        {preparing ? t.preparing : downloading ? t.downloading : checking ? t.checking : t.check}
      </button>
      {open && (
        <div className="update-check-panel">
          <p role="status" aria-live="polite">
            {message}
          </p>
          {elapsed !== null && (
            <p className="form-note">
              {locale === "ko" ? `시작 후 ${elapsed}초` : `${elapsed}s since start`}
              {sinceProgress !== null
                ? locale === "ko"
                  ? ` · 마지막 진행 기록 ${sinceProgress}초 전`
                  : ` · Last progress ${sinceProgress}s ago`
                : ""}
            </p>
          )}
          {(preparing || applying) && sinceProgress !== null && sinceProgress >= 30 && (
            <p className="form-note">
              {locale === "ko"
                ? "설치와 실행 검증을 기다리고 있습니다. 새 진행 기록을 받으면 갱신됩니다."
                : "Waiting for installation and startup verification. This view updates when new progress is recorded."}
            </p>
          )}
          {status && ["Failed", "Unresolved", "RolledBack"].includes(status.state) && (
            <div className="recovery-buttons">
              {onRecovery && (
                <button
                  onClick={() => {
                    setOpen(false);
                    onRecovery();
                  }}
                >
                  {locale === "ko" ? "설치 복구 열기" : "Open installation recovery"}
                </button>
              )}
              <button onClick={() => void exportDiagnostics()}>
                {locale === "ko" ? "진단 파일 저장" : "Save diagnostics"}
              </button>
            </div>
          )}
          {diagnosticMessage && <p role="status">{diagnosticMessage}</p>}
          {downloading && status.total !== undefined && (
            <progress aria-label={t.downloading} value={status.received ?? 0} max={status.total} />
          )}
          {status?.state === "Available" && (
            <button onClick={() => void request("download")}>{t.download}</button>
          )}
          {status?.state === "Prepared" && (
            <button onClick={() => void request("apply")}>{t.apply}</button>
          )}
          {busy && !preparing && !applying ? (
            <button onClick={() => void request("cancel")}>{t.cancel}</button>
          ) : (
            <button onClick={() => setOpen(false)}>{t.close}</button>
          )}
        </div>
      )}
    </div>
  );
}
