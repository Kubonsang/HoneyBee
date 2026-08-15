# ADR-017: Parallel Unity Batch with Batch-local Resources

## 상태

Proposed for HoneyBee v0.5 PR 1. Cross-process/global resource durability is deferred to PR 2.

## 배경

ADR-016은 하나의 Unity Work Transaction을 `prepare → acquire → Agent → TestPlay → Evidence → release`로 닫았다. v0.5의 첫 slice는 이 transaction을 수정해 여러 Agent 작업을 병렬화하되, Unity Editor/TestPlay처럼 비싼 공유 자원은 같은 batch 안에서 직렬화해야 한다. v0.4의 source 격리, child process drain, cleanup-pending, release 및 residual semantics는 그대로 유지한다.

성공한 workspace는 release와 함께 삭제된다. 따라서 검증된 변경을 Run 이후에도 사용할 수 있는 immutable Artifact로 보존해야 한다. Git Worktree integration은 이 결정의 범위가 아니다.

## 결정

### Parent와 child

- `unity batch run`은 schemaVersion 1의 strict batch config를 받아 parent Run 하나와 Work별 child Run 하나를 만든다.
- parent와 resource lifecycle이 있는 child는 모두 Journal schemaVersion 4를 사용한다. ADR-016의 schemaVersion 3 의미는 변경하지 않는다.
- parent는 config Artifact, Work ID, child Run ID, resource ID 및 최종 Work outcome/patch reference만 기록한다.
- child는 ADR-016 transaction event에 parent/work/resource linkage, resource lifecycle 및 verified patch event를 더한다.
- child Run의 resume, cancel, delete는 parent를 통해서만 수행한다. `run show`는 child linkage를 읽기 전용으로 표시할 수 있다.
- `maxParallelWorks`만큼 child Agent가 병렬 실행될 수 있다. 한 Work의 실패는 이미 실행 가능한 다른 Work를 취소하지 않으며 parent terminal summary가 전체 결과를 집계한다.

### Batch-local resource queue

- config의 resource capacity는 PR 1에서 정확히 `1`이다.
- 같은 resource ID를 요구한 child는 process-local FIFO queue로 직렬화된다. 서로 다른 resource ID는 독립적이다.
- Agent는 resource lease 없이 병렬 실행한다. resource는 TestPlay 직전에 acquire하고 TestPlay process tree가 종료된 뒤 즉시 release한다.
- acquire/queue/lease/release identity는 child Journal에 기록한다. cancel된 waiter는 실행되지 않는다.
- parent crash 후 resume은 durable state가 있는 모든 기존 child의 process drain과 cleanup을 먼저 수행한다. cleanup-pending child가 하나라도 있으면 새 Work를 dispatch하지 않는다.
- batch-local coordinator 자체는 process crash 후 복원하지 않는다. 살아 있는 child process를 drain한 뒤, 더 이상 존재하지 않는 process-local lease를 Journal에서 닫는다. 여러 HoneyBee process 사이의 실제 global capacity, scope 계약과 durable queue takeover는 PR 2의 구현 책임이다.

### Verified patch Artifact

- completed child는 source가 unchanged이고 TestPlay가 verified인 동안 workspace 결과를 patch로 캡처한다.
- patch manifest는 `unity-verified-patch` / `application/vnd.honeybee.unity-patch+json` Artifact다.
- manifest는 base source manifest, result workspace manifest 및 정렬된 `add-or-modify | delete` entry만 포함한다.
- 변경 파일 본문은 manifest에 base64로 넣지 않는다. 각 본문은 `unity-patch-content` / `application/octet-stream` Artifact로 저장하며 manifest는 그 ArtifactRef만 보유한다.
- patch builder는 clean source copy에 저장소에서 다시 읽은 content Artifact를 적용하고 result manifest와 일치하는지 검증한다. 이 검증이 끝나기 전에는 `patch.verified`나 completed outcome을 기록하지 않는다.
- workspace의 reparse entry와 hard link를 거부한다. 변경 파일 하나는 최대 16 MiB, 전체 변경 본문은 최대 64 MiB다.
- workspace release 이후에도 child Run의 content-addressed Artifact Store에 verified patch가 남는다. parent의 completed Work는 child Run ID와 patch ArtifactRef를 함께 기록한다.

### Control, resume, delete

- parent cancel은 새 Work dispatch를 중단하고 실행/대기 중 child에 cancel을 전달한 뒤 모두 settle될 때까지 기다린다.
- parent resume은 `work.registered`와 child Journal을 대조하고 기존 child recovery barrier가 끝난 뒤에만 시작되지 않은 Work를 실행한다.
- parent terminal event는 모든 registered Work가 terminal일 때만 기록한다. cleanup-pending은 terminal이 아니다.
- active 또는 indeterminate schema v4 Run은 삭제할 수 없다. terminal parent 삭제는 child executor lease를 모두 획득한 뒤 child와 parent Run을 함께 삭제한다. child 단독 삭제는 거부한다.

## 결과

v0.5 PR 1은 한 HoneyBee process 안에서 여러 독립 Unity workspace의 Agent 단계를 병렬화하고 공유 TestPlay 자원을 직렬화한다. 각 성공 결과는 workspace 수명과 분리된 verified patch Artifact로 남는다. schema v3 단일 transaction은 그대로 동작한다.

## 비범위

- cross-process/global resource queue의 durable ownership, stale takeover 및 fairness hardening(PR 2)
- Git Worktree 생성·적용·merge
- distributed scheduler 또는 daemon
- GUI, Semantic IR, Recipe 시스템
- 여러 Agent가 하나의 Work를 공동 수행하는 orchestration
- retained workspace, provider fallback, parent provisioning
