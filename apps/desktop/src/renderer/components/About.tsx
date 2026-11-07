import { useEffect, useRef, useState } from "react";
import type { DesktopAppInfoV1 } from "../../shared/ipc.js";
import support from "../../../resources/recovery-support-v1.json";
import { desktopApi } from "../desktop-api.js";
import type { Locale } from "../i18n.js";

export function About({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<DesktopAppInfoV1>();
  const [failed, setFailed] = useState(false);
  const ko = locale === "ko";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    let active = true;
    void desktopApi.appInfo().then(
      (value) => {
        if (active) setInfo(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      previous?.focus();
    };
  }, []);
  const unknown = ko ? "확인되지 않음" : "Unknown";
  return (
    <dialog
      className="modal app-info"
      ref={ref}
      onCancel={onClose}
      aria-labelledby="app-info-title"
    >
      <header>
        <h2 id="app-info-title">{ko ? "HoneyBee 정보" : "About HoneyBee"}</h2>
        <button onClick={onClose}>{ko ? "닫기" : "Close"}</button>
      </header>
      {!info && (
        <p role={failed ? "alert" : "status"}>
          {failed
            ? ko
              ? "설치 정보를 확인하지 못했습니다."
              : "Could not verify installation information."
            : ko
              ? "확인 중…"
              : "Checking…"}
        </p>
      )}
      {info && (
        <dl className="storage-versions">
          <div>
            <dt>{ko ? "앱 버전" : "App version"}</dt>
            <dd>{info.applicationVersion}</dd>
          </div>
          <div>
            <dt>{ko ? "설치 방식" : "Installation"}</dt>
            <dd>
              {
                {
                  managed: ko ? "Setup 설치" : "Setup-managed",
                  portable: ko ? "ZIP 실행" : "Portable ZIP",
                  development: ko ? "개발 빌드" : "Development build",
                }[info.installation]
              }
            </dd>
          </div>
          <div>
            <dt>{ko ? "설치된 스토리지" : "Installed storage"}</dt>
            <dd>{info.installedStorageVersion ?? unknown}</dd>
          </div>
          <div>
            <dt>{ko ? "필요한 스토리지" : "Required storage"}</dt>
            <dd>{info.requiredStorageVersion ?? unknown}</dd>
          </div>
        </dl>
      )}
      <details>
        <summary>{ko ? "지원되는 복구 범위" : "Supported recovery paths"}</summary>
        <ul>
          {support.paths.map((entry) => (
            <li key={entry.id}>{entry[locale]}</li>
          ))}
        </ul>
      </details>
      <footer>
        <button
          onClick={() => {
            void desktopApi
              .storageRecoveryAction({ action: "download-setup" })
              .catch(() => setFailed(true));
          }}
        >
          {ko ? "공식 릴리스 보기" : "Official releases"}
        </button>
      </footer>
      {info && failed && (
        <p role="alert">
          {ko ? "릴리스 페이지를 열지 못했습니다." : "Could not open the releases page."}
        </p>
      )}
    </dialog>
  );
}
