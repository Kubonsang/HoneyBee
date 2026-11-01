import { useEffect, useRef, useState } from "react";
import { X, ShieldCheck, ArrowSquareOut } from "@phosphor-icons/react";
import type { DesktopStorageRecoveryV1 } from "../../shared/ipc.js";
import { desktopApi } from "../desktop-api.js";
import type { Locale } from "../i18n.js";
import { storageRecoveryState } from "../storage-recovery.js";
import { UpdateCheck } from "./UpdateCheck.js";

const copy = {
  ko: {
    title: "스토리지 복구",
    close: "닫기",
    checking: "설치 상태 확인 중…",
    retry: "다시 확인",
    failed: "설치 상태를 확인하지 못했습니다. 다시 시도해 주세요.",
    keep: "기존 Workspace와 Git 브랜치를 유지합니다. 버전 오류 때문에 Workspace를 삭제하거나 설치 기록을 지우지 마세요.",
    installed: "설치된 스토리지",
    required: "이 앱에 필요한 스토리지",
    unknown: "확인되지 않음",
    managed: "Setup으로 관리되는 설치",
    portable: "ZIP 또는 개발 빌드",
    version: "앱과 스토리지 버전이 다릅니다.",
    legacy: "hb12 구형 서비스: 별도의 보존 복구가 필요합니다.",
    identity: "설치 소유자 또는 설치 파일을 확인해야 합니다.",
    service: "스토리지 서비스를 확인해야 합니다.",
    ready: "스토리지 검사를 통과했습니다.",
    attention: "설치 상태에 추가 확인이 필요합니다.",
    managedHelp:
      "아래에서 업데이트를 확인하세요. 준비와 파일 검증 후에만 업데이트 및 재시작을 선택할 수 있습니다. 업데이트가 거부되면 공식 Setup으로 같은 설치 경로를 선택해 보존 업데이트를 진행하세요.",
    portableHelp:
      "공식 HoneyBeeSetup.exe를 다운로드해 기존 설치 경로를 선택하세요. ZIP의 새 실행 파일만 기존 폴더에 덮어쓰면 서비스 버전은 바뀌지 않습니다.",
    identityHelp:
      "스토리지를 설치한 Windows 계정으로 실행하고, 같은 설치 경로의 Setup 복구를 사용하세요. 다른 사용자 소유의 설치를 교체할 수 없습니다.",
    legacyHelp:
      "hb12 서비스는 현재 업데이트기가 요구하는 유지보수 기능이 없습니다. 일반 업데이트나 Setup 재실행만으로 해결된다고 보장할 수 없습니다. 기존 설치와 Workspace를 유지하고, 복구 안내에 따라 별도의 검증된 보존 복구를 진행해야 합니다.",
    setup: "공식 Setup 다운로드 페이지",
    guide: "복구 안내 열기",
    details: "진단 상세",
  },
  en: {
    title: "Storage recovery",
    close: "Close",
    checking: "Checking installation…",
    retry: "Check again",
    failed: "Could not check the installation. Please try again.",
    keep: "Keep existing Workspaces and Git branches. Do not delete Workspaces or installation receipts to resolve a version mismatch.",
    installed: "Installed storage",
    required: "Storage required by this app",
    unknown: "Unknown",
    managed: "Setup-managed installation",
    portable: "ZIP or development build",
    version: "The app and storage versions differ.",
    legacy: "Legacy hb12 service: a separate preserving recovery is required.",
    identity: "Verify the installation owner or installed files.",
    service: "The storage service needs attention.",
    ready: "Storage checks passed.",
    attention: "The installation needs attention.",
    managedHelp:
      "Check for updates below. Update & Restart becomes available only after preparation and file verification. If the update is refused, use official Setup at the same installation path for a preserving update.",
    portableHelp:
      "Download official HoneyBeeSetup.exe and select the existing installation path. Copying a new ZIP executable over old files does not update the service.",
    identityHelp:
      "Run as the Windows account that installed storage and use Setup Repair at the same installation path. An installation owned by another user cannot be replaced.",
    legacyHelp:
      "The hb12 service lacks the maintenance capability required by this updater. An ordinary update or rerunning Setup cannot be promised to fix it. Keep the installation and Workspaces; a separately verified preserving recovery is required.",
    setup: "Official Setup download page",
    guide: "Open recovery guide",
    details: "Diagnostic details",
  },
};

export function StorageRecovery({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const t = copy[locale];
  const [report, setReport] = useState<DesktopStorageRecoveryV1>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const load = async (): Promise<void> => {
    const current = ++sequence.current;
    setBusy(true);
    setFailed(false);
    try {
      const next = await desktopApi.storageRecoveryStatus();
      if (current === sequence.current) setReport(next);
    } catch {
      if (current === sequence.current) {
        setFailed(true);
        setReport(undefined);
      }
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    void load();
    return () => {
      sequence.current++;
      previous?.focus();
    };
  }, []);
  const state = report ? storageRecoveryState(report.doctor.checks) : undefined;
  const versions = report?.doctor.checks.find((item) => item.code === "storage.component-version");
  const action = async (selected: "download-setup" | "open-guide"): Promise<void> => {
    try {
      await desktopApi.storageRecoveryAction({ action: selected });
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal storage-recovery"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-recovery-title"
        data-testid="storage-recovery"
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const elements = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), summary, [href], [tabindex='0']",
              ),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2 id="storage-recovery-title">{t.title}</h2>
          <button className="icon-button" aria-label={t.close} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <p className="storage-preservation">
          <ShieldCheck size={24} />
          {t.keep}
        </p>
        <div role="status" aria-live="polite">
          {busy ? t.checking : state ? t[state] : ""}
        </div>
        {failed && (
          <p role="alert" className="warning-note">
            {t.failed}
          </p>
        )}
        {report && (
          <>
            <p className="form-note">
              {report.applicationVersion} · {t[report.installation]}
            </p>
            <dl className="storage-versions">
              <div>
                <dt>{t.installed}</dt>
                <dd>{versions?.actualVersion ?? t.unknown}</dd>
              </div>
              <div>
                <dt>{t.required}</dt>
                <dd>{versions?.expectedVersion ?? t.unknown}</dd>
              </div>
            </dl>
            <ol className="storage-recovery-steps">
              <li>
                {state === "legacy"
                  ? t.legacyHelp
                  : state === "identity"
                    ? t.identityHelp
                    : report.installation === "managed"
                      ? t.managedHelp
                      : t.portableHelp}
              </li>
              {state !== "legacy" && <li>{t.legacyHelp}</li>}
            </ol>
            {report.installation === "managed" &&
              state !== "identity" &&
              state !== "legacy" &&
              state !== "ready" && <UpdateCheck locale={locale} />}
            <details>
              <summary>{t.details}</summary>
              <pre>
                {report.doctor.checks
                  .filter((item) => item.code.startsWith("storage."))
                  .map(
                    (item) =>
                      `${item.status}: ${item.code} — ${item.message}${item.subject ? ` (${item.subject})` : ""}`,
                  )
                  .join("\n")}
              </pre>
            </details>
          </>
        )}
        <footer>
          <button className="secondary" onClick={() => void action("open-guide")}>
            {t.guide}
          </button>
          <button className="secondary" onClick={() => void action("download-setup")}>
            <ArrowSquareOut size={18} />
            {t.setup}
          </button>
          <button className="primary" disabled={busy} onClick={() => void load()}>
            {t.retry}
          </button>
        </footer>
      </div>
    </div>
  );
}
