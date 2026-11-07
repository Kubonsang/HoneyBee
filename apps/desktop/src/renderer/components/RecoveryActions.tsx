import { useEffect, useRef, useState } from "react";
import type { DesktopRecoveryActionV2, DesktopRecoveryOperationV2 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { Locale } from "../i18n.js";
import { UpdateCheck } from "./UpdateCheck.js";
import { recoveryElapsed, recoveryReason, recoveryStateLabels } from "../recovery-copy.js";

export function RecoveryActions({
  locale,
  allowPreparation = true,
}: {
  locale: Locale;
  allowPreparation?: boolean;
}) {
  const ko = locale === "ko";
  const [status, setStatus] = useState<DesktopRecoveryOperationV2>();
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      const current = sequence.current;
      if (active) setNow(Date.now());
      try {
        const next = await desktopApi.recoveryOperation();
        if (active && current === sequence.current) setStatus(next);
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
    sequence.current++;
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
  const elapsed = recoveryElapsed(status?.startedAt ?? null, now);
  const sinceProgress = recoveryElapsed(status?.lastProgressAt ?? null, now);
  const reason = recoveryReason(status?.code ?? null, locale);
  const stalled =
    sinceProgress !== null &&
    sinceProgress >= 30 &&
    status &&
    ["Starting", "Running", "Verifying", "Unresolved"].includes(status.state);
  const exportDiagnostics = async (): Promise<void> => {
    setSending(true);
    setFailed(false);
    setSaved(false);
    try {
      setSaved(await desktopApi.exportRecoveryDiagnostics());
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="recovery-actions" aria-label={ko ? "설치 복구" : "Installation recovery"}>
      {failed && (
        <p role="alert">
          {ko
            ? "요청을 완료하지 못했습니다. 설치와 복구 기록을 유지하고 상태를 다시 확인해 주세요."
            : "The request could not complete. Keep the installation and recovery records and check its status again."}
        </p>
      )}
      {status && (allowPreparation || status.state !== "Idle") && (
        <p role="status" aria-live="polite">
          <strong>{recoveryStateLabels[locale][status.state]}</strong> {status.version ?? ""}
        </p>
      )}
      {elapsed !== null && (
        <p className="form-note">
          {ko ? `시작 후 ${elapsed}초` : `${elapsed}s since start`}
          {sinceProgress !== null
            ? ko
              ? ` · 마지막 진행 기록 ${sinceProgress}초 전`
              : ` · Last recorded progress ${sinceProgress}s ago`
            : ""}
        </p>
      )}
      {reason && <p className="warning-note">{reason}</p>}
      {status?.state === "Downloading" && status.received !== null && status.total !== null && (
        <div>
          <progress
            value={status.received}
            max={status.total}
            aria-label={ko ? "Setup 다운로드" : "Setup download"}
          />
          <p className="form-note">
            {(status.received / 1048576).toFixed(1)} / {(status.total / 1048576).toFixed(1)} MB
          </p>
        </div>
      )}
      {idle && allowPreparation && (
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
            <strong>{ko ? "실행할 작업" : "Action"}: </strong>
            {status.route === "setup-repair"
              ? ko
                ? "현재 버전의 설치 복구"
                : "Repair the current installation"
              : ko
                ? "스토리지 보존 전환"
                : "Preserving storage transition"}
          </p>
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
          {(status.state === "Unresolved" || stalled) && !status.canCancel && (
            <button disabled={sending} onClick={() => void action(withJob("resume"))}>
              {ko ? "기존 작업 확인 및 재개" : "Check and resume existing operation"}
            </button>
          )}
        </>
      )}
      {status?.route === "application-update" && <UpdateCheck locale={locale} />}
      {status && !["Idle", "Checking", "Downloading", "Review"].includes(status.state) && (
        <p className="form-note">
          {status.preservation === "unchanged"
            ? ko
              ? "이 작업에서 설치 변경을 시작하지 않았습니다."
              : "This operation has not started installation changes."
            : status.preservation === "verified"
              ? ko
                ? "보존 검증 기록을 확인했습니다."
                : "Preservation evidence was verified."
              : ko
                ? "Workspace 전체 내용의 보존 검증 결과는 이 화면에서 확인되지 않았습니다. 기존 데이터와 기록을 유지하세요."
                : "This screen has no complete Workspace preservation verification. Keep existing data and records."}
        </p>
      )}
      <div className="recovery-diagnostics">
        <button className="secondary" disabled={sending} onClick={() => void exportDiagnostics()}>
          {ko ? "진단 파일 저장" : "Save diagnostics"}
        </button>
        <span className="form-note">
          {ko
            ? "버전·검사 결과·오류 코드만 저장합니다. 자동 전송하지 않습니다."
            : "Saves versions, check results and error codes locally. No automatic upload."}
        </span>
      </div>
      {saved && <p role="status">{ko ? "진단 파일을 저장했습니다." : "Diagnostics saved."}</p>}
    </section>
  );
}
