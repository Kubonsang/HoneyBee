# ADR-013: Core/CLI 우선과 프로세스 간 Handoff 증명

- 상태: 승인
- 기준일: 2026-08-08
- 후속 결정: ADR-014가 이 proof를 strict sequential orchestration kernel로 확장한다.

## 결정

HoneyBee의 본체를 재사용 가능한 `packages/core`와 `apps/cli`로 둔다. 기존 VS Code Extension과 전용 UI 패키지는 폐기하고 저장소에서 제거한다.

첫 CLI 수직 슬라이스의 완료 조건은 다음 하나다.

1. HoneyBee가 producer Agent를 별도 OS 프로세스로 시작한다.
2. producer의 stdout 결과를 HoneyBee Core가 회수한다.
3. Core가 원래 Task와 producer 결과를 reviewer Agent의 stdin으로 전달한다.
4. reviewer도 별도 OS 프로세스로 실행되며, Core가 그 stdout을 최종 결과로 반환한다.
5. 두 PID, handoff 이벤트와 최종 결과를 통합 테스트에서 확인한다.

Agent CLI 계약은 의도적으로 작다. executable과 argv는 shell 문자열로 합치지 않고, Prompt는 stdin으로 전달하며, stdout을 해당 단계의 결과로 사용한다. timeout, 출력 상한, spawn 실패와 non-zero exit는 typed Core 오류로 반환한다.

## 근거

이 경계는 에디터 UI, Webview 상태, Extension Host 수명주기 없이 HoneyBee의 핵심 가치인 Agent 간 작업 전달을 직접 검증한다. Codex, OpenCode 또는 다른 CLI는 동일한 command/args 설정으로 교체할 수 있고, 결정적 demo Agent를 통해 네트워크와 계정 없이도 프로세스 경계를 자동 검증할 수 있다.

## 결과

- `packages/core`가 handoff workflow와 child-process Adapter를 소유한다.
- `apps/cli`가 `run`과 `demo` 명령을 제공한다.
- 기존 `packages/session-runtime`은 보존하지만 이번 proof의 실행 경로에는 포함되지 않는다.
- `apps/vscode-extension`과 `packages/ui-shared`는 제거한다.
- PTY/TUI, 병렬 fan-out, 세션 영속화, 재시도와 다단계 graph orchestration은 이 proof 이후의 별도 결정으로 남긴다.
