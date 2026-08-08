# Honey Bee 초기 아키텍처

- 상태: 폐기됨 — ADR-013의 Core/CLI 구조로 대체
- 기준일: 2026-07-29
- 적용 범위: 현재 Vertical Slice
- 관련 결정: [ADR-001](../decisions/ADR-001-windows-first.md) ~ [ADR-007](../decisions/ADR-007-unity-cli-adapter-boundary.md)

## 1. 목적과 결정 우선순위

이 문서는 Honey Bee의 첫 구현이 따라야 할 프로세스 경계, 소스 의존성, 런타임 계약과 단계별 검증 기준을 정의한다. 장기 제품 전체를 한 번에 설계하거나 구현하는 문서가 아니라, 가장 작은 실행 가능한 경로를 안전하게 만든 뒤 Workspace, StorageDriver, Unity 통합으로 확장하기 위한 기준선이다.

판단 근거의 우선순위는 다음과 같다.

1. 사용자가 확정한 현재 범위와 제약
2. `Honey_Bee_Technical_Architecture_and_Optimization_v0.2_Windows_TypeScript.docx`
3. `Honey_Bee_SRS_v0.1.docx`

하위 문서의 요구사항이 상위 결정과 충돌하면 상위 결정을 따른다. 충돌하지 않는 SRS 요구사항은 장기 백로그의 근거로 유지한다.

## 2. 요구사항 요약

### 2.1 현재 Vertical Slice의 목표

현재 슬라이스는 Windows에서 “Session을 구성하고 선택한 뒤 Custom Command Agent와 대화하고 다시 열어 metadata와 Draft를 복원하는 흐름”을 끝까지 증명한다.

1. Extension activation 시 versioned Session metadata, tag, 관계, selected Session과 세션별 Draft를 `globalState`에서 복원한다.
2. 사용자는 Session을 생성·조회·이름 변경·보관·삭제하고 현재 Session을 명시적으로 선택한다.
3. 사용자는 tag와 부모·관련 관계를 편집하며, Domain은 self-reference, dangling reference와 부모 hierarchy cycle을 거부한다.
4. Header는 선택된 Session, Agent command, Windows cwd, tag, PTY 상태와 last exit를 항상 표시한다.
5. `CustomCommandAgentAdapter`는 executable, argv, cwd와 허용된 environment로 임의 CLI Agent 또는 Echo Fixture를 시작한다.
6. 별도 Node Runtime이 세션별 `node-pty`/ConPTY process와 bounded log를 소유한다.
7. 각 Session은 독립 xterm instance/scrollback을 가지며 Session 전환이 다른 PTY의 입출력과 섞이지 않는다.
8. Monaco Prompt는 세션별 Draft를 유지하고 표준 key policy에 따라 전송과 줄바꿈을 구분한다.
9. 사용자는 선택 Session에 입력, resize, interrupt와 stop을 보내고 exit code/reason을 Header에서 확인한다.
10. PTY 문자열과 구조화 lifecycle event는 JSONL을 통해 분리 전달된다.
11. 한글 입력·출력과 공백·한글이 포함된 Windows 경로를 Echo Fixture로 검증한다.
12. Extension 재활성화 시 metadata와 Draft는 복원하되 종료된 PTY process 자체를 복원한다고 주장하지 않는다.

이 슬라이스는 단일 PTY 데모가 아니다. Session의 사용자 가치와 Extension Host↔Runtime 경계를 함께 검증하는 최소 제품 단위다.

### 2.2 현재 포함 범위

- Windows 11 로컬 개발과 Windows CI
- TypeScript strict mode, 계층·package 의존성 규칙
- Session CRUD, 명시적 선택과 Header
- 사용자 정의 태그(`tag`)
- 단일 부모와 비계층 related 관계, 부모 cycle 거부
- `CustomCommandAgentAdapter`
- 세션별 PTY/ConPTY, xterm, input, resize, interrupt, stop과 exit
- Monaco Prompt: Enter 전송, Alt+Enter/Shift+Enter 줄바꿈, Ctrl+Enter 전송
- 세션별 미전송 Draft
- `globalState` 기반 versioned metadata·Draft 복원과 migration
- 별도 Node Runtime과 stdin/stdout JSONL IPC
- PTY 문자열과 구조화 lifecycle event 분리
- 세션별 bounded Runtime log와 bounded xterm scrollback
- 한글/UTF-8과 공백·한글·괄호가 포함된 Windows 경로
- Echo Fixture, Fake Runtime과 계약·통합 테스트

### 2.3 현재 구현에서 제외하는 것

현재 Vertical Slice에서 명시적으로 제외하는 실제 integration은 다음 세 가지다.

- 실제 Unity executable/Unity CLI/C# Bridge/testplay 호출
- 실제 Git worktree 생성·전환·삭제
- 실제 Library Image COW, ReFS block clone, 증분·물리 복사와 Native Helper

`packages/workspace`와 ADR-006/ADR-007은 위 기능의 Port·fixture 경계를 정의하지만 실제 외부 작업을 수행하지 않는다. 이 제외를 이유로 Session, Tool Profile metadata, persistence, structured event 또는 UI acceptance를 축소하지 않는다.

## 3. 충돌 해소

| 충돌                | 기준 문서의 기존 내용                                   | 현재 확정 결정                                                                                                                                      |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 운영체제            | SRS v0.1은 Windows, macOS, Linux를 열거                 | [ADR-001](../decisions/ADR-001-windows-first.md)에 따라 Windows 11 구현·CI만 지원한다.                                                              |
| 주 언어             | 과거 Go Sidecar 또는 다중 언어 가능성                   | [ADR-002](../decisions/ADR-002-typescript-first.md)에 따라 제품 로직과 현재 slice는 TypeScript-first다.                                             |
| Raw/Structured 출력 | Raw PTY 보존과 구조화 Console을 함께 요구               | [ADR-003](../decisions/ADR-003-pty-structured-events.md)에 따라 PTY 문자열과 typed event를 분리한다.                                                |
| Session 의미        | 일부 UI 은유가 Hive/Worker 역할을 암시할 수 있음        | [ADR-004](../decisions/ADR-004-user-directed-session-model.md)에 따라 사용자가 CRUD·tag·관계를 자율적으로 정하며 시스템은 역할을 강제하지 않는다.   |
| Runtime 위치        | Sidecar 필요와 Extension 생태계 재사용 요구             | [ADR-005](../decisions/ADR-005-extension-host-runtime-boundary.md)에 따라 UI/metadata는 Extension Host, PTY/process는 별도 Node Runtime이 소유한다. |
| Library 최적화      | SRS MVP와 기술 문서는 worktree/Library 기능을 넓게 포함 | [ADR-006](../decisions/ADR-006-library-image-storage-driver.md)의 추상화만 유지하고 실제 worktree/COW는 현재 구현에서 제외한다.                     |
| Unity 통합          | Unity CLI와 Bridge가 초기 범위처럼 보일 수 있음         | [ADR-007](../decisions/ADR-007-unity-cli-adapter-boundary.md)의 Port·fixture만 유지하고 실제 Unity 호출은 제외한다.                                 |

현재 Vertical Slice 축소는 Session 기능을 제거하는 축소가 아니다. 실제 Unity/worktree/COW integration을 잘라내고 Session→Prompt→Agent→PTY→복원 흐름을 완성하는 축소다.

## 4. 아키텍처 개요

### 4.1 프로세스 뷰

```text
VS Code Extension Host / apps/vscode-extension
┌──────────────────────────────────────────────────────────┐
│ UI / Presentation                                        │
│   └─ Application use cases                               │
│       └─ RuntimeClientPort                               │
└───────────────────────┬──────────────────────────────────┘
                        │ stdin/stdout JSONL
                        │ stderr = Runtime 진단 로그
┌───────────────────────▼──────────────────────────────────┐
│ Honey Bee Node Runtime (별도 프로세스)                   │
│ Application handlers / Domain / Ports / composition root │
│   └─ PtyProcessPort                                      │
└───────────────────────┬──────────────────────────────────┘
                        │ node-pty string API
┌───────────────────────▼──────────────────────────────────┐
│ node-pty Adapter → Windows ConPTY → Agent CLI            │
└──────────────────────────────────────────────────────────┘
```

Extension Host는 화면 상태, 명령 등록, 사용자 입력 수집과 Runtime 연결만 담당한다. PTY 프로세스 소유권, 종료 처리, timeout, child process 정리는 Runtime에 둔다. Runtime crash는 Extension Host crash로 전파되지 않아야 하며, Extension은 연결 끊김을 명시적 상태로 표시한다.

### 4.2 호출 흐름과 소스 의존성

사용자 요청의 논리적 호출 흐름은 다음과 같다.

```text
UI → Application → Domain → Ports → Adapters
```

여기서 마지막 `Ports → Adapters`는 런타임 바인딩을 뜻한다. 컴파일 시 Adapter를 Port에 주입하는 composition root를 제외하면, Port가 구체 Adapter를 import하지 않는다.

실제 소스 의존성 규칙은 다음과 같다.

```text
UI ───────────────→ Application
Application ──────→ Domain
Application ──────→ Ports
Domain ───────────→ (외부 의존성 없음)
Adapters ─────────→ Ports + 외부 라이브러리
Composition Root ─→ Application + Ports + Adapters
```

이 구분은 호출 순서를 그대로 유지하면서 의존성 역전 원칙을 지킨다. TypeScript package와 composition 기준은 [ADR-002](../decisions/ADR-002-typescript-first.md)을 따른다.

### 4.3 계층 책임

#### UI / Presentation

- Session Tree에서 CRUD, tag, 부모·관련 관계와 선택 command를 연결한다.
- Session Header, 세션별 xterm과 Monaco Prompt를 렌더링한다.
- Header에는 title, tag, Agent adapter/command, Windows cwd, PTY state와 last exit를 표시한다.
- Monaco Prompt의 전송/줄바꿈 key policy와 focus를 처리한다.
- Runtime typed event를 선택된 Session view model에 projection한다.
- `node-pty` object와 child process를 직접 소유하지 않는다.

#### Application

- `CreateSession`, `RenameSession`, `ArchiveSession`, `DeleteSession`, `SelectSession`을 조정한다.
- `SetTags`, `SetParent`, `RelateSessions`에서 Domain invariant와 persistence를 연결한다.
- `StartAgent`, `SendPrompt`, `ResizePty`, `InterruptAgent`, `StopAgent`를 정확한 `sessionId`로 라우팅한다.
- Draft 저장·복원, Runtime handshake와 stale state reconciliation을 조정한다.
- Port interface만 알고 VS Code API, child process와 `node-pty`를 import하지 않는다.

#### Domain

- `Session`, `SessionId`, `SessionStatus`, tag, parent, related 관계를 정의한다.
- parent graph의 self-reference, dangling reference와 cycle을 거부한다.
- related 관계는 비계층·대칭이며 self/duplicate를 거부한다.
- `AgentRunState`, `TerminalSize`, `ExitReason`과 `idle → starting → running → stopping → exited|failed` 전이를 검증한다.
- 프로세스, JSON, Buffer, VS Code와 Node event emitter 타입을 노출하지 않는다.

#### Ports

- `SessionRepositoryPort`, `MetadataStorePort`, `RuntimeClientPort`, `PtyProcessPort`, `AgentAdapterPort`를 현재 사용한다.
- `ClockPort`, `IdGeneratorPort`, `DiagnosticSinkPort`로 비결정적 외부 효과를 격리한다.
- 향후 `GitWorktreePort`, `StorageDriver`, `UnityCommandPort`는 `packages/workspace` 경계에 두되 현재 실제 호출은 없다.
- wire DTO와 Domain type을 분리한다.

#### Adapters

- VS Code `globalState`, stdio JSONL, `node-pty`/ConPTY와 Custom Command spawn을 캡슐화한다.
- `CustomCommandAgentAdapter`는 executable과 argv 배열, cwd와 허용된 environment만 받는다.
- 공백·한글·괄호가 있는 Windows path를 shell 문자열 결합 없이 전달한다.
- 외부 exit code, 예외, 문자열과 JSON을 typed Result/Error로 변환한다.
- Adapter 간 직접 workflow 호출을 피하고 Application을 통해 조정한다.

### 4.4 저장소 구조

저장소 구조는 다음 이름과 책임을 기준으로 한다.

```text
apps/
  vscode-extension/
packages/
  domain/
  session-runtime/
  agent-adapters/
  workspace/
  tool-profiles/
  event-contracts/
  persistence/
  ui-shared/
  test-fixtures/
```

- `apps/vscode-extension`: activation, commands/views, Session UI, xterm, Monaco, Header, `globalState` Adapter와 Runtime client
- `packages/domain`: Session·관계·Agent Run의 순수 규칙
- `packages/session-runtime`: 별도 Node Runtime, handler, PTY supervisor, bounded log와 composition root
- `packages/agent-adapters`: `CustomCommandAgentAdapter`와 Agent Adapter registry
- `packages/workspace`: Workspace reference, `StorageDriver`/Unity Port와 fake만 포함; 실제 worktree/COW/Unity는 제외
- `packages/tool-profiles`: Custom Command executable/argv/cwd/environment policy
- `packages/event-contracts`: JSONL schema, structured event와 error code
- `packages/persistence`: versioned metadata codec, migration와 repository Port
- `packages/ui-shared`: Header/view model과 Monaco key policy
- `packages/test-fixtures`: Echo Fixture, Fake Runtime과 protocol golden fixture

### 4.5 Session 상태 소유권

- Domain metadata의 권위는 Session Application과 `SessionRepositoryPort`에 있다.
- VS Code `globalState` Adapter는 Session metadata, tag, 관계, selected id와 Draft만 저장한다.
- Runtime은 세션별 PTY handle, process state와 bounded ring log만 소유한다.
- xterm instance와 scrollback은 Extension UI가 세션별로 소유하되 권위 있는 영속 transcript로 간주하지 않는다.
- Runtime handshake 후 Extension은 metadata와 live process state를 조정한다. 복원할 수 없는 이전 `running` 상태는 `runtime_lost`/`exited`로 표시한다.

### 4.6 Monaco Prompt와 Header

- 표준 mode에서 Enter는 전송, Alt+Enter/Shift+Enter는 줄바꿈, Ctrl+Enter는 전송이다.
- Draft는 입력 변경 시 선택 Session id 아래 저장하고 전송 성공 시에만 비운다.
- Raw Terminal focus에서는 Esc, Ctrl+C와 Alt 조합을 Monaco command가 가로채지 않는다.
- 선택 변경은 Header, Draft, xterm과 input 대상이 같은 Session을 가리킨 뒤 화면에 반영한다.

## 5. 별도 Node Runtime과 JSONL IPC

### 5.1 프로세스 소유권

- Extension은 Runtime child process의 bootstrap, handshake와 연결 상태를 관리한다.
- Runtime은 `CustomCommandAgentAdapter`와 모든 Session PTY의 부모이자 정리 책임자다.
- Runtime은 `sessionId`마다 독립 process handle, event sequence와 bounded ring log를 둔다.
- Runtime stdout은 JSONL protocol 전용이다.
- Runtime 진단 로그는 stderr로만 기록한다.
- Agent stdout/stderr는 PTY가 합친 문자열 데이터로 취급하며 Runtime stdout에 직접 쓰지 않는다. 반드시 JSON event로 감싼다.
- Extension의 `globalState`는 Session metadata와 Draft만 저장하며 PTY handle이나 전체 log를 저장하지 않는다.
- Extension 종료, IPC EOF, Runtime crash와 Agent exit의 정리 순서를 명시적으로 처리한다.

### 5.2 Wire envelope

모든 message는 한 줄에 하나의 JSON object이며 UTF-8과 LF를 사용한다. 문자열 안의 줄바꿈은 JSON escape로 표현한다.

```json
{"schemaVersion":1,"kind":"request","id":"req-12","method":"agent.start","params":{"sessionId":"session-3","runId":"run-7","command":"echo-fixture","args":[],"cwd":"C:\\한글 경로\\Demo Project"}}
{"schemaVersion":1,"kind":"response","id":"req-12","ok":true,"result":{"state":"starting"}}
{"schemaVersion":1,"kind":"event","event":"pty.data","sessionId":"session-3","runId":"run-7","seq":42,"data":"안녕하세요\r\n"}
```

최소 공통 필드는 다음과 같다.

- `schemaVersion`: protocol 호환성 판단
- `kind`: `request`, `response`, `event`
- `id`: request와 response 상관관계
- `method` 또는 `event`: allowlist에 등록된 식별자
- `sessionId`: UI, Draft, PTY, xterm과 Header routing의 필수 범위
- `runId`: Agent 실행 범위가 있는 message에 필수
- `seq`: 같은 Run의 순서 확인이 필요한 event에 단조 증가 값
- `result` 또는 `error`: response의 상호 배타 필드

`error`는 최소한 `code`, `message`, `retryable`, 선택적 `details`를 가진다. stack trace와 secret은 wire error에 싣지 않고 진단 로그로 분리한다.

### 5.3 Framing과 방어 규칙

- 수신자는 chunk를 줄 단위라고 가정하지 않고 내부 buffer에 누적한다.
- LF를 만날 때만 한 frame을 꺼낸다. CRLF는 입력 호환을 위해 허용하되 송신은 LF로 통일한다.
- 한 chunk에 여러 줄이 오거나 한 JSON object가 여러 chunk로 나뉘는 경우를 모두 처리한다.
- 최대 line 크기와 최대 누적 buffer를 둔다. 초과 시 해당 연결을 protocol error로 종료한다.
- 빈 줄은 무시할 수 있지만 JSON이 아닌 stdout은 protocol 위반으로 기록한다.
- JSON parse 후 반드시 schema validation을 수행한다.
- 알 수 없는 `schemaVersion`, `kind`, `method`, `event`는 typed error로 처리한다.
- 같은 request `id`의 중복 response와 종료된 `runId`의 늦은 event를 탐지한다.
- PTY 고용량 출력은 event batch 또는 flow control로 UI를 보호한다. 데이터 손실 정책이 필요하면 먼저 디스크 spool이나 명시적 truncation event를 정의한다.

상세 결정은 [ADR-005](../decisions/ADR-005-extension-host-runtime-boundary.md)을 따른다.

## 6. PTY 문자열 계약과 raw byte 한계

현재 `node-pty` 경계의 공개 데이터 모델은 문자열이다. 따라서 Honey Bee의 Raw Terminal에서 “raw”는 다음을 뜻한다.

- PTY에서 받은 문자열과 ANSI/제어 시퀀스를 구조화 파서가 변형하지 않고 terminal renderer에 전달한다.
- 사용자 키 입력도 UI command로 해석하지 않고 PTY 문자열 입력으로 전달한다.
- PTY data event와 구조화 Console용 best-effort parser는 서로 독립적인 소비 경로를 가진다.

“raw”는 다음을 보장하지 않는다.

- OS PTY가 낸 임의 byte sequence의 byte-for-byte 보존
- 유효하지 않은 인코딩 byte의 복원
- 문자열로 변환된 뒤 원래 byte 배열의 재구성
- stdout과 stderr의 원래 분리

따라서 현재 Port는 `Buffer`나 `Uint8Array`를 거짓으로 노출하지 않는다. 개념적 계약은 `onData(data: string)`과 `write(data: string)`이다. JSONL event는 이 문자열을 JSON escape해 전달하고, UI는 다시 해석하거나 정규화하지 않은 채 xterm 계열 renderer에 쓴다.

각 Session의 xterm scrollback과 Runtime ring log는 bounded하다. 상한 도달은 조용한 손실이 아니라 `log.truncated` structured event로 표시한다.

byte-perfect 캡처가 실제 요구가 되면 다음 순서로 별도 결정을 내린다.

1. 재현 가능한 실패 fixture와 필요한 byte 보존 수준을 정의한다.
2. `supportsRawBytes` 같은 capability로 기존 문자열 Adapter와 구분한다.
3. native helper 또는 별도 binary transport를 검토한다.
4. Domain을 Node `Buffer`에 결합하지 않고 byte stream 전용 Port를 추가한다.

상세 결정은 [ADR-003](../decisions/ADR-003-pty-structured-events.md)을 따른다.

## 7. 향후 확장 경계

### 7.1 Workspace

Workspace는 단순 디렉터리가 아니라 Git worktree, branch, Library 상태, 연결된 Session/Run을 묶는 Domain aggregate 후보다. 현재 슬라이스의 `packages/workspace`에는 reference, Port와 fake만 두고 실제 Git worktree와 Library copy는 수행하지 않는다.

향후 Application use case는 다음 책임을 조정한다.

- Workspace 생성 계획과 dry-run
- Git worktree 생성
- Library 준비 또는 재생성
- lock 획득과 중단 복구 marker
- 준비 상태 검증 후 `READY` 승격
- 삭제 전 dirty Git, 실행 중 Agent, Unity process, file lock 검사

`WorkspacePort` 하나에 Git, storage, Unity 검사를 모두 넣지 않는다. 조정은 Application에 두고 `GitWorktreePort`, `StorageDriver`, `WorkspaceLockPort`, `UnityProcessProbePort`로 기능을 나눈다.

### 7.2 StorageDriver

`StorageDriver`는 “Workspace에 쓰기 가능한 격리 Library를 준비한다”는 결과 중심 계약을 제공한다. OS 기술 이름을 Domain에 노출하지 않는다.

후보 capability는 다음과 같다.

- volume 및 driver capability probe
- immutable base에서 writable destination 준비
- copy progress와 cancellation
- bytes, file count, 선택적 hash 검증
- incomplete marker와 cleanup
- logical/physical size 보고

우선순위는 안전한 PhysicalCopy, 검증된 증분 복사, 측정 근거가 있는 ReFS block clone 순이다. 선택적 Rust Helper는 동일 Port를 구현하는 Adapter이며 별도 exe + versioned JSON protocol을 사용한다. Helper 실패 시 안전한 Driver로 fallback할 수 있어야 한다.

상세 결정은 [ADR-006](../decisions/ADR-006-library-image-storage-driver.md)을 따른다.

### 7.3 Unity

Application과 Domain은 Unity executable 경로, CLI flag, stdout 문구를 알지 않는다. `UnityCommandPort`는 등록된 command와 typed input/output만 노출한다.

구체 Unity CLI Adapter의 책임은 다음과 같다.

- 프로젝트/Workspace와 Unity 버전 확인
- argv 배열 구성과 Windows quoting
- timeout, cancellation, exit code 수집
- stdout/stderr 또는 JSON의 schema validation
- 외부 오류를 안정적인 Honey Bee error code로 변환
- capability/version 탐지

C# UPM Bridge는 Unity Editor 내부 API가 필요한 등록 명령과 딥링크만 담당한다. Session, Workspace, cache, permission policy는 구현하지 않는다. 임의 `eval`은 현재 및 초기 Unity 단계의 기본 계약에 포함하지 않는다.

상세 결정은 [ADR-007](../decisions/ADR-007-unity-cli-adapter-boundary.md)을 따른다.

## 8. 수명주기와 오류 모델

### 8.1 Agent Run 상태

```text
idle
  └─ start → starting
                 ├─ spawned → running
                 └─ spawn error → failed
running
  ├─ process exit → exited
  ├─ stop/interrupt → stopping → exited|failed
  └─ runtime disconnect → failed(unknown_process_state)
```

- 같은 `runId`의 중복 start는 거부하거나 동일 결과를 반환하는 정책 중 하나로 고정하고 테스트한다.
- `starting`, `running`, `stopping`에서 Extension 연결이 끊기면 Runtime이 고아 프로세스 정책을 적용한다.
- 프로세스 exit code, signal/termination reason, 사용자 stop, Runtime failure를 구분한다.
- 상태 event는 순서를 갖고, UI는 이전 상태로 되돌아가는 늦은 event를 무시한다.

### 8.2 오류 분류

- `validation.*`: 잘못된 command, 크기, terminal size
- `protocol.*`: JSON parse, schema version, unknown method, line limit
- `runtime.*`: spawn 실패, Runtime 종료, internal failure
- `pty.*`: write, resize, ConPTY 초기화 실패
- `agent.*`: Agent non-zero exit, executable not found
- `security.*`: cwd 범위, 금지된 capability, secret redaction

사용자 메시지는 무엇이 실패했는지, 현재 Agent 상태, 안전한 다음 행동을 보여준다. 외부 오류 문자열을 UI 분기 조건으로 사용하지 않는다.

## 9. 보안과 운영 원칙

- command와 args는 분리된 배열로 전달하고 shell 문자열 조합을 피한다.
- `cwd`는 Runtime에서 정규화하고 허용된 Workspace 범위를 확인한다. 현재 slice의 허용 범위 정책은 구현 PR에서 명시한다.
- protocol과 진단 로그에서 token, API key, 환경 변수 secret을 마스킹한다.
- Runtime stdout에는 JSONL 외의 로그를 쓰지 않는다.
- 예상하지 못한 Agent 출력은 구조화 파싱을 포기해도 Raw Terminal 경로는 유지한다.
- 모든 child process는 timeout/cancellation과 최종 정리 경로를 가진다.
- 강제 종료는 정상 interrupt/stop이 실패한 뒤의 제한된 fallback이다.

## 10. 단계별 PR 계획

각 PR은 기능, 리팩터링과 dependency upgrade를 섞지 않으며 독립적으로 검증 가능해야 한다.

### PR 0 — 교정된 아키텍처 기준선

- 이 문서와 정확한 ADR-001~ADR-007
- 현재 포함 범위와 실제 Unity/worktree/COW 제외 확정
- 저장소 package 이름과 dependency rule 확정
- 완료 조건: UTF-8, 내부 링크, 제목, 범위와 모순 검사

### PR 1 — TypeScript 골격과 event contracts

- `apps/vscode-extension`와 합의된 아홉 packages 골격
- Domain value object, Result/Error와 JSONL schema
- import boundary 검사
- 완료 조건: schema round-trip, Domain의 외부 import 금지와 Windows CI

### PR 2 — 사용자 자율형 Session Domain

- Session CRUD·선택과 status
- tag, parent와 related 관계
- self/dangling/duplicate와 parent cycle 거부
- in-memory repository와 순수 unit test
- 완료 조건: 관계 invariant와 삭제·선택 fallback test

### PR 3 — persistence와 Extension metadata 복원

- versioned Session metadata codec와 migration
- VS Code `globalState` Adapter
- 세션별 Draft와 selected Session 복원
- stale `starting`/`running` 상태 정규화
- 완료 조건: round-trip, schema migration, 손상 metadata와 activation test

### PR 4 — 별도 Runtime, JSONL과 Custom Command

- Runtime bootstrap, handshake와 shutdown
- JSONL encoder/decoder, request correlation, timeout과 EOF
- `CustomCommandAgentAdapter`
- Echo Fixture: 한글, Windows path, ANSI, 긴 출력, interrupt와 exit
- 완료 조건: split/coalesced/malformed frame과 argv/cwd fixture

### PR 5 — 세션별 PTY/xterm과 구조화 이벤트

- `node-pty`/ConPTY start, input, resize, interrupt, stop과 exit
- 세션별 xterm instance와 정확한 `sessionId` routing
- PTY string data와 lifecycle event 분리
- bounded ring log, bounded scrollback와 `log.truncated`
- 완료 조건: 다중 Session 출력 격리, 빠른 exit, spawn failure와 고아 process test

### PR 6 — Monaco Prompt와 Session Header

- Enter 전송, Alt+Enter/Shift+Enter 줄바꿈, Ctrl+Enter 전송
- 세션별 Draft 저장·전환·전송 후 clear
- Header의 Session/Agent/cwd/tag/state/last exit
- Raw Terminal focus key pass-through
- 완료 조건: Session 전환 시 Header, Draft, xterm과 input 대상 일치

### PR 7 — Vertical Slice 통합과 안정화

- backpressure, line limit, event sequence와 secret redaction
- 한글/IME와 공백·한글·괄호가 있는 Windows path smoke
- Runtime crash, Extension reload와 metadata 복원
- bounded log 성능 baseline과 장애 주입
- 완료 조건: 아래 전체 체크리스트와 Echo Fixture end-to-end 통과

### 현재 Slice 이후의 실제 integration

다음은 현재 완료 기준을 통과하고 범위를 다시 확정한 후에만 시작한다.

1. 실제 Git worktree Adapter
2. 실제 PhysicalCopy/증분 복사와 Library Image
3. 측정 근거가 있는 ReFS COW/Native Helper
4. 실제 Unity CLI Adapter와 C# Bridge/testplay

## 11. 검증 체크리스트

### 문서·구조·경계

- [ ] ADR-001~ADR-007 파일이 한 개씩 있고 제목이 결정 목록과 정확히 일치한다.
- [ ] 잘못된 기존 ADR-002~ADR-005 파일명과 링크가 남아 있지 않다.
- [ ] 모든 Markdown이 UTF-8이며 내부 `.md` 링크가 존재한다.
- [ ] 저장소 구조가 `apps/vscode-extension`과 합의된 아홉 packages를 정확히 사용한다.
- [ ] `UI → Application → Domain → Ports → Adapters` 호출 흐름과 역전된 compile dependency가 구분되어 있다.
- [ ] Domain이 VS Code, Node, `node-pty`와 JSON wire type을 import하지 않는다.
- [ ] Windows-only와 macOS/Linux 비지원이 문서·CI·수용 기준에서 일치한다.

### Session CRUD·선택·관계

- [ ] Session create/read/rename/update/archive/delete가 검증된다.
- [ ] 현재 Session 선택과 삭제 후 deterministic fallback/empty state가 검증된다.
- [ ] tag 추가·제거와 duplicate normalization이 검증된다.
- [ ] parent 지정·해제와 self/missing parent 거부가 검증된다.
- [ ] A→B→C 뒤 C→A parent edge가 cycle error로 거부된다.
- [ ] related 관계가 대칭이며 self/duplicate를 거부한다.
- [ ] related edge가 parent hierarchy cycle 의미로 오해되지 않는다.

### Extension UI·Draft·복원

- [ ] Header가 선택 Session, Agent command, cwd, tag, PTY state와 last exit를 표시한다.
- [ ] Session 전환 시 Header, Monaco Draft, xterm과 input 대상이 같은 `sessionId`다.
- [ ] Enter 전송, Alt+Enter/Shift+Enter 줄바꿈, Ctrl+Enter 전송이 검증된다.
- [ ] Raw Terminal focus에서 Esc, Ctrl+C와 Alt 조합을 가로채지 않는다.
- [ ] Draft가 Session별로 저장되고 전송 성공 시 해당 Session Draft만 비워진다.
- [ ] `globalState`가 metadata, tag, 관계, selected id와 Draft를 round-trip한다.
- [ ] schema migration과 손상 metadata fallback이 검증된다.
- [ ] 재활성화 시 이전 live PTY 복원을 주장하지 않고 stale running 상태를 정규화한다.

### Custom Command·PTY·xterm

- [ ] `CustomCommandAgentAdapter`가 executable과 argv를 분리해 spawn한다.
- [ ] 공백·한글·괄호가 포함된 Windows cwd와 argument가 shell 재해석 없이 전달된다.
- [ ] Session마다 별도 PTY process와 xterm instance/scrollback을 가진다.
- [ ] 한 Session의 input, resize, interrupt, exit가 다른 Session에 전달되지 않는다.
- [ ] interrupt, 정상 exit, non-zero exit, spawn error와 forced terminate를 구분한다.
- [ ] ANSI/control sequence 문자열을 structured parser가 변형하지 않는다.
- [ ] `node-pty` 문자열 API를 raw byte API로 설명하지 않는다.
- [ ] Runtime/Extension 종료 뒤 고아 Agent process가 남지 않는다.

### PTY와 구조화 이벤트·bounded log

- [ ] `pty.data`와 lifecycle/tool structured event가 독립 경로다.
- [ ] structured event validation 실패 중에도 xterm data가 계속 전달된다.
- [ ] `sessionId`, `runId`와 `seq`가 routing/순서 검증에 사용된다.
- [ ] Runtime ring log와 xterm scrollback에 line/byte/event 상한이 있다.
- [ ] 상한 도달 시 `log.truncated` event와 사용자 표시가 있다.
- [ ] 대용량 Echo 출력에서 UI freeze 없이 batching/backpressure가 동작한다.

### JSONL IPC

- [ ] Runtime stdout은 JSONL 전용이고 stderr 진단과 섞이지 않는다.
- [ ] split frame과 여러 frame이 합쳐진 chunk를 처리한다.
- [ ] CRLF 입력 호환과 LF 송신을 검증한다.
- [ ] malformed JSON, unknown version/method/event가 typed error가 된다.
- [ ] 최대 line/buffer, request timeout, cancellation과 duplicate ID를 검증한다.
- [ ] IPC EOF와 Runtime crash가 연결 Session의 `runtime_lost`로 전파된다.

### Echo Fixture·Windows

- [ ] Echo Fixture가 plain echo, 한글, ANSI, multiline, 긴 출력과 exit code를 제공한다.
- [ ] Echo Fixture가 interrupt를 관찰 가능하게 처리한다.
- [ ] Windows 11과 사용할 Node Runtime 버전을 결과에 기록한다.
- [ ] 한글/IME 입력과 UTF-8 출력의 실제 동작·제한을 기록한다.
- [ ] 공백·한글·괄호가 포함된 Windows path end-to-end test가 통과한다.

### 현재 제외 경계

- [ ] 실제 Unity executable, CLI, C# Bridge와 testplay를 호출하지 않는다.
- [ ] 실제 Git worktree를 생성·전환·삭제하지 않는다.
- [ ] 실제 Library Image COW, clone, copy 또는 Native Helper를 실행하지 않는다.
- [ ] `StorageDriver`와 `UnityCommandPort`는 fake/contract로만 검증된다.

## 12. 남은 위험

- `node-pty`와 ConPTY의 실제 문자열 인코딩·IME·TUI 동작은 Windows fixture로 검증해야 한다.
- Runtime 배포 방식과 사용할 Node LTS 버전은 패키징 제약을 확인한 뒤 확정해야 한다.
- JSONL은 초기 단순성에 유리하지만 대용량 PTY 출력에서 복사·escape 비용이 커질 수 있다. 측정 전 binary transport로 확장하지 않는다.
- Extension 종료 시 Agent를 함께 종료할지, Runtime을 일정 시간 유지할지는 제품 UX 결정이 필요하다.
- 현재 slice는 Windows `cwd`와 한글 경로 검증을 포함하지만, 향후 Workspace resolution이 허용할 root·symlink·UNC 정책은 별도로 확정해야 한다.
- bounded log의 잘림 표시와 Session 전환 뒤 xterm replay가 사용자에게 충분히 예측 가능한지 실제 대용량 출력으로 검증해야 한다.
- `globalState` schema migration과 손상 관계 데이터 복구가 parent cycle 불변식을 깨지 않는지 property test가 필요하다.
- Workspace, Library, StorageDriver, Unity 계약은 의도적으로 개념 경계만 정의했으며 실제 API는 해당 use case와 fixture가 준비될 때 구체화해야 한다.

## 13. 결정 기록

- [ADR-001: Windows-first 지원 정책](../decisions/ADR-001-windows-first.md)
- [ADR-002: TypeScript-first 아키텍처](../decisions/ADR-002-typescript-first.md)
- [ADR-003: PTY와 구조화 이벤트 분리](../decisions/ADR-003-pty-structured-events.md)
- [ADR-004: 사용자 자율형 세션 모델](../decisions/ADR-004-user-directed-session-model.md)
- [ADR-005: Extension Host와 Runtime 책임 분리](../decisions/ADR-005-extension-host-runtime-boundary.md)
- [ADR-006: Library Image Storage Driver 추상화](../decisions/ADR-006-library-image-storage-driver.md)
- [ADR-007: Unity CLI Adapter 경계](../decisions/ADR-007-unity-cli-adapter-boundary.md)
