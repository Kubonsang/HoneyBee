# ADR-005: Extension Host와 Runtime 책임 분리

- 상태: 승인
- 결정일: 2026-07-29

## 맥락

VS Code Extension Host는 사용자 입력과 화면 응답을 담당하지만 PTY, 대용량 로그와 장수 child process를 직접 소유하면 UI 멈춤과 crash 전파 위험이 커진다. 반대로 별도 Runtime이 UI metadata나 VS Code lifecycle을 소유하면 `globalState`, view와 process 상태가 중복된다.

## 결정

Extension Host와 별도 Node Runtime의 책임을 다음과 같이 분리한다.

### Extension Host 책임

- Extension activation/deactivation과 command/view 등록
- Session CRUD·선택 use case의 UI binding
- Session Tree, Header, 세션별 xterm과 Monaco Prompt
- Monaco Prompt key policy와 focus routing
- versioned Session metadata, 관계, selected id와 Draft의 `globalState` 저장·복원
- Runtime child process bootstrap, handshake와 Runtime client
- typed event를 view model로 projection하고 사용자 오류를 표시

Extension Host는 `node-pty`를 import하거나 Agent child process를 직접 spawn하지 않는다. PTY handle, 전체 raw log 또는 살아 있는 process를 `globalState`에 저장하지 않는다.

### Runtime 책임

- `CustomCommandAgentAdapter`를 통한 executable + argv 실행
- 세션별 `node-pty`/ConPTY process, input, resize, interrupt, terminate와 exit 수명주기
- 세션별 bounded ring log, event sequence와 backpressure
- Windows cwd/path validation과 spawn error 정규화
- PTY string data와 structured lifecycle event 발행
- Extension EOF, Runtime shutdown과 Agent exit 시 child process 정리

Runtime은 VS Code API, UI widget 또는 `globalState`를 알지 않는다. Session title·tag·관계의 권위 있는 metadata store 역할을 맡지 않는다.

### JSONL IPC

- Extension request는 Runtime stdin으로 보낸다.
- Runtime response와 event는 stdout의 UTF-8 JSONL로 보낸다.
- Runtime stdout은 protocol 전용이며 진단 로그는 stderr로 보낸다.
- envelope는 `schemaVersion`, `kind`, request `id`, `sessionId`와 method/event를 가진다.
- 수신 chunk를 line으로 가정하지 않고 LF까지 buffer에 누적한다.
- split/coalesced frame, malformed JSON, unknown version, 최대 line/buffer와 timeout을 처리한다.
- PTY data의 내부 줄바꿈은 JSON string escape다.

### 장애와 복원

- Runtime crash 또는 IPC EOF를 모든 연결 Session에 `runtime_lost`로 표시한다.
- Extension 재활성화는 `globalState` metadata와 Draft를 복원한 뒤 새 Runtime과 handshake한다.
- 이전 PTY가 복원된다고 가정하지 않으며 사용자가 명시적으로 다시 시작한다.
- 종료 시 interrupt/terminate 순서와 timeout을 적용하고 고아 process 검사를 수행한다.

## 결과

### 긍정적

- PTY/process 장애가 Extension UI crash로 직접 전파되지 않는다.
- persistence metadata와 실행 resource의 owner가 명확하다.
- Echo Fixture로 Runtime을 VS Code 없이 검증하고 UI를 Fake Runtime으로 검증할 수 있다.

### 비용과 제한

- JSONL schema, correlation, timeout과 lifecycle reconciliation이 필요하다.
- Runtime 재시작 후 live PTY를 이어 붙이지 않는다.
- bounded log와 xterm scrollback의 상한·truncation UX를 정의해야 한다.

## 검토한 대안

### Extension Host가 PTY를 직접 소유

초기 코드는 작지만 응답성과 장애 격리 요구를 위반하므로 채택하지 않는다.

### Runtime이 Session metadata까지 영속화

VS Code `globalState`와 권위가 중복되고 현재 단일 사용자 Extension 범위에 과하다.

### Named Pipe 또는 gRPC를 먼저 도입

현재 parent-child 단일 client에는 stdio JSONL보다 복잡하므로 측정된 필요가 생길 때 재검토한다.

## 검증

- Extension package에서 `node-pty`와 직접 spawn import가 없음
- Runtime package에서 VS Code API와 `globalState` import가 없음
- JSONL split/coalesced/malformed/EOF fixture
- Runtime crash, Extension dispose, interrupt와 exit 후 고아 process 없음
- `globalState` metadata/Draft 복원과 stale running 상태 정규화

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-004](ADR-004-user-directed-session-model.md)
- [ADR-002](ADR-002-typescript-first.md)
