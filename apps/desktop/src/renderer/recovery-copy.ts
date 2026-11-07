import type { DesktopRecoveryOperationV2 } from "../shared/ipc.js";
import type { Locale } from "./i18n.js";

export const recoveryStateLabels: Record<
  Locale,
  Record<DesktopRecoveryOperationV2["state"], string>
> = {
  ko: {
    Idle: "복구 방법을 선택하세요",
    Checking: "설치와 배포 정보 확인 중",
    Downloading: "검증할 설치 파일 다운로드 중",
    Review: "실행할 복구 내용 확인",
    Starting: "복구 실행 준비 중",
    Running: "Setup에서 복구 진행 중",
    Verifying: "설치 상태와 앱 시작 확인 중",
    Succeeded: "복구와 앱 시작을 확인했습니다",
    RolledBack: "이전 버전으로 돌아왔습니다",
    Cancelled: "작업을 취소했습니다",
    Failed: "복구 준비를 완료하지 못했습니다",
    Unresolved: "복구 결과를 추가로 확인해야 합니다",
    Blocked: "이 복구 경로를 진행할 수 없습니다",
  },
  en: {
    Idle: "Choose a recovery action",
    Checking: "Checking installation and release",
    Downloading: "Downloading installer for verification",
    Review: "Review the recovery",
    Starting: "Preparing to run recovery",
    Running: "Recovery is running in Setup",
    Verifying: "Checking installation and app startup",
    Succeeded: "Recovery and app startup verified",
    RolledBack: "The previous version was restored",
    Cancelled: "Operation cancelled",
    Failed: "Recovery preparation could not complete",
    Unresolved: "The recovery result needs attention",
    Blocked: "This recovery path is unavailable",
  },
};
const reasons: Record<string, readonly [string, string]> = {
  "recovery.application-update-failed": [
    "업데이트를 완료하지 못했습니다. 진단을 저장하고 설치 복구 화면에서 상태를 확인하세요.",
    "The update did not complete. Save diagnostics and check the installation recovery screen.",
  ],
  "recovery.identity-unverified": [
    "설치 소유자나 파일의 무결성을 확인하지 못했습니다. 원래 설치 계정과 경로를 확인하세요.",
    "The installation owner or file integrity could not be verified. Check the original account and installation path.",
  ],
  "recovery.release-unavailable": [
    "인증된 배포 정보를 가져오지 못했습니다. 네트워크 연결과 공식 릴리스를 확인한 뒤 다시 준비하세요.",
    "An authenticated release could not be retrieved. Check the network and official release before preparing again.",
  ],
  "recovery.prepare-failed": [
    "복구 준비 중 문제가 발생했습니다. 진단을 저장하고 다시 확인하세요.",
    "Preparation failed. Save diagnostics and check the installation again.",
  ],
  "recovery.download-failed": [
    "설치 파일 다운로드 또는 해시 검증이 실패했습니다. 연결을 확인한 뒤 다시 준비하세요.",
    "Installer download or hash verification failed. Check the connection and prepare again.",
  ],
  "recovery.download-interrupted": [
    "다운로드가 완료되지 않았습니다. 준비를 취소한 뒤 새로 다운로드하세요.",
    "The download did not finish. Cancel preparation before downloading again.",
  ],
  "recovery.records-unavailable": [
    "기존 작업 기록을 확인하지 못했습니다. 진단을 저장하고 복구 안내를 확인하세요.",
    "Existing operation records could not be verified. Save diagnostics and consult the recovery guide.",
  ],
  "recovery.use-app-update": [
    "스토리지 버전이 일치합니다. 아래 앱 업데이트로 계속하세요.",
    "The storage version matches. Continue with the application updater below.",
  ],
  "recovery.operation-active": [
    "기존 복구 작업이 실행 중입니다. Setup 창에서 진행 상황을 확인하세요.",
    "A recovery operation is already active. Check its Setup window.",
  ],
  "recovery.setup-incomplete": [
    "Setup이 완료되지 않았습니다. 설치 창과 Windows 승인 요청을 확인하세요. 중단된 경우 같은 작업을 재개할 수 있습니다.",
    "Setup did not complete. Check its window and any Windows approval request. An interrupted operation can resume the same job.",
  ],
  "recovery.verification-required": [
    "설치 상태 또는 새 앱의 시작을 아직 확인하지 못했습니다. 기존 작업을 확인하고 재개하세요.",
    "Installation health or app startup has not been confirmed. Check and resume the existing operation.",
  ],
  "recovery.source-changed": [
    "준비 이후 설치 상태가 달라졌거나 지원되지 않는 상태입니다. 설치 정보를 다시 확인하세요.",
    "The installation changed after preparation or is unsupported. Check the installation information again.",
  ],
  "recovery.rolled-back": [
    "업데이트가 완료되지 않아 이전 버전이 선택됐습니다. 진단을 저장하고 원인을 확인하세요.",
    "The update did not complete and the previous version was selected. Save diagnostics to investigate.",
  ],
};
export function recoveryReason(code: string | null, locale: Locale): string | undefined {
  return code === null ? undefined : reasons[code]?.[locale === "ko" ? 0 : 1];
}
export function recoveryElapsed(start: string | null, now: number): number | null {
  if (start === null) return null;
  const parsed = Date.parse(start);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
}
