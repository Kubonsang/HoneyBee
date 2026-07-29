# ADR-002: TypeScript-first 아키텍처

- 상태: 승인
- 결정일: 2026-07-29
- 적용 범위: 전체 저장소와 현재 Vertical Slice

## 맥락

Honey Bee는 VS Code UI, Session Domain, Node Runtime, PTY, persistence와 향후 Workspace·Unity Adapter를 함께 개발한다. 여러 언어와 중복 계약을 초기부터 도입하면 Session, Event, Error schema가 경계마다 달라지고 작은 PR의 검토 비용이 커진다.

기술 기준 문서 v0.2는 Extension, Runtime, UI와 Adapter를 TypeScript로 통일하고 Unity 내부 API와 Windows native 기능만 경계 밖으로 격리하도록 제안한다.

## 결정

제품 로직과 현재 Vertical Slice를 TypeScript-first로 구현한다.

- TypeScript strict mode를 사용한다.
- `noUncheckedIndexedAccess`와 `exactOptionalPropertyTypes`를 활성화하는 방향을 따른다.
- 외부 JSON은 schema validation 후 Domain type으로 변환한다.
- Session, PTY lifecycle, Event, Error와 persistence metadata 계약을 TypeScript에서 공유한다.
- `unknown`을 경계 입력 타입으로 사용하고 제품 코드의 무분별한 `any`를 금지한다.
- process spawn은 shell 문자열이 아니라 executable과 argv 배열을 사용한다.
- Windows path는 Value Object 또는 `path.win32` 경계에서 처리한다.

## 저장소 구조

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

- `apps/vscode-extension`: Extension activation, command/view 등록, xterm, Monaco Prompt, Header와 `globalState` Adapter
- `packages/domain`: Session, 관계, 상태 전이와 순수 invariant
- `packages/session-runtime`: 별도 Node Runtime, Application handler, PTY supervisor와 bounded log
- `packages/agent-adapters`: `CustomCommandAgentAdapter`와 향후 Agent별 Adapter
- `packages/workspace`: 현재는 Workspace reference와 향후 StorageDriver/Unity Port 경계만 포함
- `packages/tool-profiles`: Custom Command 실행 설정과 capability metadata
- `packages/event-contracts`: JSONL request/response/event schema와 error code
- `packages/persistence`: versioned Session metadata codec, repository Port와 migration
- `packages/ui-shared`: view model, Header model, Monaco key policy
- `packages/test-fixtures`: Echo Fixture와 protocol/PTY fixture

## TypeScript 밖의 경계

- Unity Editor 내부 API가 필요할 때만 C# UPM Bridge를 사용한다.
- ReFS clone이나 Windows handle 조사에 측정된 필요가 있을 때만 별도 Rust Helper를 검토한다.
- 기존 독립 CLI를 연결할 때는 재작성보다 versioned JSON Adapter를 우선한다.
- 현재 Vertical Slice에는 C#, Rust 또는 실제 Unity 실행이 없다.

## 의존성 규칙

논리 호출 흐름은 `UI → Application → Domain → Ports → Adapters`다. 컴파일 의존성은 Domain이 외부 package를 모르고, Adapter가 자신이 구현하는 Port를 향하도록 역전한다. composition root만 구체 Adapter를 조립한다.

## 결과

### 긍정적

- UI, Runtime과 계약에서 같은 타입·schema를 재사용할 수 있다.
- Agent가 만든 PR에서 Domain, Adapter와 wire 변경이 함께 드러난다.
- 현재 범위의 언어·빌드·디버깅 표면을 작게 유지한다.

### 비용과 제한

- Node와 VS Code API에 대한 타입 경계 discipline이 필요하다.
- Unity·native 경계를 TypeScript로 억지로 재구현해서는 안 된다.
- package 수가 책임 없는 전달 계층으로 변하지 않도록 public API를 작게 유지해야 한다.

## 검증

- 저장소의 실행 코드가 합의된 디렉터리 구조를 따른다.
- Domain package에 VS Code, `node-pty`, filesystem, JSON wire type import가 없다.
- 외부 JSON validation과 package dependency rule이 CI에서 실패 가능하다.
- Echo Fixture를 포함한 현재 Vertical Slice가 TypeScript만으로 실행된다.

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-004](ADR-004-user-directed-session-model.md)
