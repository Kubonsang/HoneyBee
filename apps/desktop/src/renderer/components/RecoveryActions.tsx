import { useEffect, useState } from "react";
import type { DesktopRecoveryActionV2, DesktopRecoveryOperationV2 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { Locale } from "../i18n.js";
import { UpdateCheck } from "./UpdateCheck.js";

export function RecoveryActions({ locale }: { locale: Locale }) {
  const ko = locale === "ko";
  const [status, setStatus] = useState<DesktopRecoveryOperationV2>();
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const next = await desktopApi.recoveryOperation();
        if (active) setStatus(next);
      } catch {
        if (active) setFailed(true);
      }
      if (active)
        timer = setTimeout(() => {
          void refresh();
        }, 1500);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  const action = async (request: DesktopRecoveryActionV2): Promise<void> => {
    setSending(true);
    setFailed(false);
    try {
      setStatus(await desktopApi.recoveryAction(request));
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  const withJob = (name: "execute" | "resume" | "cancel"): DesktopRecoveryActionV2 =>
    status?.jobId ? { action: name, jobId: status.jobId } : { action: "cancel" };
  const idle =
    status &&
    ["Idle", "Succeeded", "RolledBack", "Cancelled", "Failed", "Blocked"].includes(status.state);
  return (
    <section className="recovery-actions" aria-label={ko ? "설치 복구" : "Installation recovery"}>
      {failed && (
        <p role="alert">
          {ko
            ? "요청을 완료하지 못했습니다. 설치와 복구 기록을 유지하고 상태를 다시 확인해 주세요."
            : "The request could not complete. Keep the installation and recovery records and check its status again."}
        </p>
      )}
      {status && (
        <p role="status" aria-live="polite">
          {status.state} {status.version ?? ""}
        </p>
      )}
      {status?.state === "Downloading" && status.received !== null && status.total !== null && (
        <progress
          value={status.received}
          max={status.total}
          aria-label={ko ? "Setup 다운로드" : "Setup download"}
        />
      )}
      {idle && (
        <div className="recovery-buttons">
          <button disabled={sending} onClick={() => void action({ action: "prepare-update" })}>
            {ko ? "보존 업데이트 준비" : "Prepare preserving update"}
          </button>
          <button disabled={sending} onClick={() => void action({ action: "prepare-repair" })}>
            {ko ? "현재 버전 복구 준비" : "Prepare current-version repair"}
          </button>
        </div>
      )}
      {status?.state === "Review" && (
        <>
          <p>
            {ko
              ? `${status.version} 설치 파일의 서명과 해시를 확인했습니다. 실행하면 HoneyBee를 닫고 Setup에서 복구를 진행합니다. 기존 Workspace와 브랜치는 유지하는 경로입니다. Windows 승인 창이 나타날 수 있습니다.`
              : `The signature and hash of the ${status.version} installer were verified. Continuing closes HoneyBee and runs Setup using the preserving path. Windows may request approval.`}
          </p>
          <button
            className="primary"
            disabled={sending}
            onClick={() => void action(withJob("execute"))}
          >
            {ko ? "복구 실행 및 다시 시작" : "Run recovery and restart"}
          </button>
        </>
      )}
      {status?.canCancel && (
        <button disabled={sending} onClick={() => void action(withJob("cancel"))}>
          {ko ? "준비 취소" : "Cancel preparation"}
        </button>
      )}
      {status && ["Starting", "Running", "Verifying", "Unresolved"].includes(status.state) && (
        <>
          <p>
            {ko
              ? "Setup과 Windows 승인 창을 확인해 주세요. 앱이 닫혀도 작업 기록은 유지됩니다."
              : "Check Setup and any Windows approval prompt. The operation record remains after the app closes."}
          </p>
          {status.state === "Unresolved" && !status.canCancel && (
            <button disabled={sending} onClick={() => void action(withJob("resume"))}>
              {ko ? "기존 작업 확인 및 재개" : "Check and resume existing operation"}
            </button>
          )}
        </>
      )}
      {status?.route === "application-update" && <UpdateCheck locale={locale} />}
    </section>
  );
}
