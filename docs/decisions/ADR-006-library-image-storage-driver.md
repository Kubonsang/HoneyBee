# ADR-006: Library Image Storage Driver 추상화

- 상태: 승인, 구현은 유예
- 결정일: 2026-07-29

## 맥락

SRS는 Git worktree와 Unity Library 상태를 하나의 Workspace로 다루고, 쓰기 가능한 Library를 Workspace 간 공유하지 않도록 요구한다. 기술 아키텍처 v0.2는 PhysicalCopy, 증분 복사, 선택적 ReFS block clone과 Rust Helper를 제안한다.

현재 Vertical Slice에서는 실제 Git worktree 조작과 Library Image COW·clone·copy를 구현하지 않는다. 다만 향후 Workspace workflow가 특정 파일시스템 기술이나 하나의 거대한 manager에 결합되지 않도록 Port와 책임 경계를 지금 확정한다.

## 결정

Workspace orchestration과 storage mechanics를 분리한다.

### Workspace/Application 책임

- 생성·삭제 plan과 dry-run
- Git worktree, storage, lock, Unity process probe의 작업 순서
- Domain 상태 전이와 보상/복구 흐름
- dirty Git, 실행 중 Agent, Unity process, file lock에 대한 삭제 gate
- 준비 검증 후에만 `READY`로 승격

### Domain 책임

- Workspace identity와 상태
- 하나의 writable Library가 여러 Workspace에 연결되지 않는 invariant
- `CREATING`, `READY`, `FAILED`, `DELETING`, `INCOMPLETE` 같은 상태 전이
- storage 기술과 무관한 fingerprint/compatibility 결과

### Port 분리

- `GitWorktreePort`: create, inspect dirty state, remove
- `StorageDriver`: capability probe, prepare writable copy, verify, cleanup, size report
- `WorkspaceLockPort`: lock acquire/release와 stale lock 검사
- `UnityProcessProbePort`: 대상 프로젝트의 import/compile/editor 상태 확인

Application이 이 Port들을 조정한다. `WorkspacePort`라는 단일 interface에 모든 외부 기능을 합치지 않는다.

### StorageDriver 정책

- 안전한 PhysicalCopy를 기준 fallback으로 둔다.
- 증분 복사나 ReFS block clone은 capability와 검증을 통과한 Adapter로 추가한다.
- 성공 결과는 driver, logical/physical bytes, file count, 검증 결과를 포함한다.
- 중단 시 incomplete marker를 남기고 불완전한 destination을 재사용하지 않는다.
- cancel과 progress는 Port 계약에 포함하되 UI 이벤트 형식과 결합하지 않는다.
- Rust Helper는 별도 exe와 versioned JSON protocol을 쓰며 crash 시 안전한 Driver로 fallback한다.

## 결과

### 긍정적

- Git, copy, lock, Unity 검사의 실패와 복구를 독립적으로 테스트할 수 있다.
- ReFS/Rust 실험이 Workspace Domain을 오염시키지 않는다.
- 안전한 fallback이 제품 기능의 전제 조건으로 유지된다.

### 비용과 제한

- 여러 Port를 조정하는 Application workflow와 보상 로직이 필요하다.
- 파일 단위 원자성이 없는 복사에서는 marker와 검증이 필수다.
- physical bytes와 clone 지원 여부는 실제 Windows volume fixture가 필요하다.

## 검토한 대안

### WorkspaceManager가 Git과 모든 파일 작업을 직접 수행

빠르게 비대해지고 테스트 fixture가 결합된다. 채택하지 않는다.

### Rust Helper를 기본 구현으로 사용

배포, signing, 권한, crash 표면이 늘어난다. Node 구현의 기능/성능 부족이 측정될 때만 추가한다.

### 하나의 writable Library 공유

Unity cache 오염과 동시 쓰기 위험이 요구사항에 반한다. 채택하지 않는다.

## 구현 전 검증 항목

- 많은 작은 파일, lock 파일, 긴 경로, 중단 복사 fixture
- source/destination 동일 volume과 다른 volume
- dirty worktree와 실행 중 Agent/Unity process 삭제 gate
- incomplete marker와 재시도/cleanup
- bytes, file count, 선택적 hash 검증
- Driver capability 오탐 시 PhysicalCopy fallback

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-001](ADR-001-windows-first.md)
- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-002](ADR-002-typescript-first.md)
