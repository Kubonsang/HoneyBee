# ADR-003: PTY와 구조화 이벤트 분리

- 상태: 승인
- 결정일: 2026-07-29

## 맥락

Raw Terminal은 알 수 없는 CLI Agent, ANSI 제어 시퀀스와 TUI를 최대한 그대로 전달해야 한다. 동시에 Session Header, lifecycle, interrupt, exit와 향후 Tool Activity를 안정적인 구조화 이벤트로 표시해야 한다. Agent 출력 문자열을 사후 파싱해 두 요구를 한 경로에 묶으면 parser 실패가 터미널 호환성을 깨뜨린다.

`node-pty`의 공개 data API는 문자열을 제공하므로 이 경계에서 임의 raw byte의 byte-for-byte 보존을 약속할 수 없다.

## 결정

PTY data와 Honey Bee 구조화 이벤트를 독립된 두 채널로 유지한다.

```text
node-pty string data ──→ pty.data event ──→ session별 xterm
Runtime/Application ───→ typed event ─────→ Header, 상태, Result UI
```

### PTY 채널

- 세션마다 독립 PTY와 xterm instance/scrollback을 가진다.
- `pty.data`는 수신 문자열과 ANSI/control sequence를 해석·정규화하지 않고 xterm에 전달한다.
- 입력, resize와 interrupt는 해당 Session의 PTY handle로만 라우팅한다.
- 세션 전환은 다른 PTY를 종료하거나 출력 buffer를 합치지 않는다.
- Raw Terminal의 “raw”는 수신 문자열 무가공 전달이며 raw byte 보존을 뜻하지 않는다.

### 구조화 이벤트 채널

- `session.created`, `session.updated`, `session.selected`, `process.started`, `process.interrupted`, `process.exited`, `runtime.error`처럼 versioned event를 사용한다.
- event는 `schemaVersion`, `eventId`, `timestamp`, `sessionId`, `type`, `payload`를 가진다.
- 현재 `CustomCommandAgentAdapter`는 process lifecycle과 PTY data를 제공하며 임의 Agent stdout을 Tool Event로 추측하지 않는다.
- 향후 Native Agent Adapter나 trusted shim만 `tool_call`, `tool_result`, `approval_request`를 명시적으로 발행한다.
- parser 또는 structured projection 실패는 PTY data 전달을 중단시키지 않는다.

### 전송과 bounded log

- Extension Host와 별도 Runtime 사이에서는 request/response/event JSONL envelope를 사용한다.
- PTY 문자열의 줄바꿈은 JSON string escape이며 wire frame 경계가 아니다.
- Runtime은 세션별 bounded ring log를 유지해 일시적 UI 재연결을 지원한다.
- xterm scrollback과 Runtime ring log는 line/byte/event 상한을 가지며 truncation을 명시적 event로 알린다.
- 원본 byte나 무제한 전체 로그 보존을 주장하지 않는다.

## 결과

### 긍정적

- 구조화 기능이 실패해도 Raw Terminal과 임의 Agent 호환성이 유지된다.
- Header와 lifecycle UI가 stdout 문구에 의존하지 않는다.
- 대용량 출력의 backpressure와 log 상한을 채널별로 검증할 수 있다.

### 비용과 제한

- UI가 두 event projection을 조정해야 한다.
- PTY data와 lifecycle event의 상대 순서는 `sessionId`와 `seq`로 다뤄야 한다.
- invalid encoding byte는 문자열 변환 전 상태로 복원할 수 없다.

## 검토한 대안

### Agent stdout을 단일 structured parser로 처리

미지원 Agent와 TUI를 깨뜨리므로 채택하지 않는다.

### PTY 문자열을 UTF-8 Buffer로 재인코딩해 raw byte로 표시

원래 byte를 복원한다는 보장이 없어 채택하지 않는다.

### 무제한 로그 보존

Extension memory와 `globalState`를 오염시키므로 bounded log와 명시적 truncation을 사용한다.

## 검증

- ANSI, cursor 이동, 한글, 긴 출력과 resize Echo Fixture
- structured event validation 실패 중에도 PTY 화면이 계속 갱신됨
- 세션 전환 시 각 xterm scrollback과 PTY routing이 분리됨
- bounded log 상한과 truncation event
- interrupt와 exit event가 stdout 문자열 파싱 없이 표시됨

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-004](ADR-004-user-directed-session-model.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-007](ADR-007-unity-cli-adapter-boundary.md)
