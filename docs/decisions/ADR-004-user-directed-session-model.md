# ADR-004: 사용자 자율형 세션 모델

- 상태: 승인
- 결정일: 2026-07-29

## 맥락

SRS는 사용자가 Session을 직접 생성·이름 지정·분류하고 Honey Bee가 Hive, Worker 또는 특정 역할 의미를 강제하지 않도록 요구한다. 현재 Vertical Slice도 PTY 데모가 아니라 사용자가 여러 Session을 구분하고 선택해 각각의 Prompt, Draft와 실행 상태를 유지하는 흐름을 포함한다.

## 결정

Session을 사용자 소유의 최상위 대화·실행 단위로 정의한다. 시스템이 역할이나 자동 hierarchy를 부여하지 않는다.

### Session 데이터

- 필수: `id`, `title`, `createdAt`, `updatedAt`, `status`
- 선택: `tags`, `parentId`, `relatedSessionIds`, `agentProfileId`, `workspaceRef`, `archivedAt`
- UI 상태: selected Session id, 세션별 Draft, Header view model
- Runtime 상태: 세션별 PTY/run handle, bounded log와 last exit

### CRUD와 선택

- 사용자는 Session을 생성, 조회, 이름·metadata 수정, 보관 또는 삭제할 수 있다.
- 하나의 Session을 현재 입력 대상으로 명시적으로 선택한다.
- 선택 변경은 Header, Monaco Prompt Draft와 xterm view를 같은 Session으로 원자적으로 전환한다.
- 삭제는 실행 중 PTY와 관계를 확인하고 명시적 정책에 따라 거부하거나 먼저 종료한다.
- 현재 선택 Session 삭제 시 결정적인 fallback 선택 또는 빈 상태를 만든다.

### 태그와 관계

- Session은 중복 제거된 사용자 정의 tag 여러 개를 가질 수 있다.
- `parentId`는 사용자 트리의 단일 부모를 뜻한다.
- 부모 edge 추가·변경 전 대상에서 현재 Session까지 도달 가능한지 검사하고 hierarchy cycle을 거부한다.
- self-parent, 존재하지 않는 Session, 이미 삭제된 Session 참조를 거부한다.
- `relatedSessionIds`는 비계층·대칭 관계이며 self-link와 duplicate를 거부한다.
- related edge는 hierarchy cycle 판정에 포함하지 않는다. 관계 의미를 자동으로 부모·검증·대안으로 바꾸지 않는다.

### 세션별 격리

- 각 Session은 독립 `CustomCommandAgentAdapter` 설정, PTY, xterm, Monaco Draft와 bounded log projection을 가진다.
- 다른 Session의 PTY data, interrupt, resize 또는 exit가 현재 Session으로 라우팅되지 않아야 한다.
- Header는 선택된 Session title, tag, Agent command, Windows cwd, process state와 last exit를 항상 표시한다.

### 복원

- versioned Session metadata, tag, 관계, selected id와 Draft를 VS Code `globalState` Adapter로 저장한다.
- activation 시 metadata를 복원하고 schema migration을 적용한다.
- PTY handle과 실행 중 process 자체는 `globalState`에 저장하거나 복원한다고 주장하지 않는다.
- 이전 `starting`/`running` 상태는 Runtime handshake 결과에 따라 `exited` 또는 `runtime_lost`로 정규화한다.

## 결과

### 긍정적

- 사용자가 작업 구조를 스스로 정하고 Honey Bee는 일관성과 cycle 안전성만 보장한다.
- Session 전환 후 Draft, Header와 Terminal 대상 혼동을 줄인다.
- 저장 가능한 metadata와 살아 있는 Runtime resource를 명확히 분리한다.

### 비용과 제한

- 관계 mutation과 삭제 시 참조 무결성 검사가 필요하다.
- Runtime 재시작 뒤 PTY transcript 전체 복원은 현재 보장하지 않는다.
- `globalState` migration과 손상 데이터 복구 정책이 필요하다.

## 검토한 대안

### Hive/Worker 역할을 Domain에 고정

사용자 자율형 분류 요구에 반하므로 채택하지 않는다.

### 관련 관계를 모두 방향성 hierarchy로 취급

자유로운 연관 표현을 막고 불필요한 cycle 제약을 만들므로 parent graph만 acyclic하게 유지한다.

### Session metadata와 PTY log를 모두 `globalState`에 저장

크기와 복구 의미가 불명확하므로 metadata와 Draft만 저장하고 출력은 bounded runtime/UI log로 둔다.

## 검증

- Session create/read/update/archive/delete와 선택
- tag 중복 제거, self-parent, missing parent와 parent cycle 거부
- related self/duplicate 거부와 대칭성
- Session 전환 시 Header, Draft, xterm, input 대상 일치
- `globalState` round-trip, version migration과 stale running 상태 정규화

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
- [ADR-002](ADR-002-typescript-first.md)
