# ADR-018: Durable Global Unity Resource Leases

## 상태

Accepted for HoneyBee v0.5 PR 2.

## 배경

ADR-017의 batch-local FIFO queue는 한 HoneyBee process 안에서만 Unity Editor/TestPlay capacity를 제한한다. 서로 다른 batch process가 같은 host에서 실행되면 동일한 비싼 자원을 동시에 사용할 수 있고, queue 또는 active lease를 가진 process가 종료되면 메모리 상태가 사라진다. 이 문제를 해결하되 ADR-016의 child process drain, workspace cleanup, verified patch 및 residual semantics를 약화하면 안 된다.

## 결정

### 공개 계약과 범위

- 기존 batch config schema 1은 `batch-local-v1` 의미로 그대로 유지한다.
- batch config schema 2는 strict top-level `resourceScope: "global-file-v1"`을 필수로 한다. 알 수 없는 필드와 다른 scope 값은 거부한다.
- parent와 resource-managed child의 workflow Journal은 계속 schema 4다. `workflow.started` linkage의 resource scope만 `batch-local-v1 | global-file-v1`을 명시적으로 구분한다.
- global scope는 한 host에서 동일한 HoneyBee state root를 사용하는 process에 한정한다. daemon, network coordination 및 distributed scheduler는 도입하지 않는다.
- resource capacity는 계속 정확히 1이다. Agent phase는 병렬로 실행하며 resource lease는 TestPlay 직전에 acquire하고 TestPlay process tree 종료 뒤 release한다.

### Durable resource state

- resource별 operational journal은 `<state-root>/.unity-resources/v1/<resource-id>/events`에 immutable numbered JSON event로 저장한다.
- typed event는 `resource.queued`, `resource.acquired`, `resource.cancelled`, `resource.released`뿐이며 resource ID, request ID, owner child Run ID, FIFO ticket과 필요한 lease ID만 기록한다. task, prompt, Agent output, TestPlay output 또는 Artifact 본문은 기록하지 않는다.
- event는 private temporary file을 write+sync한 다음 최종 sequence path에 no-overwrite hard-link로 publish한다. sequence gap, invalid file type, schema 오류, 불가능한 transition 또는 중복 request journal은 fail-closed `run.indeterminate`다.
- 짧은 read/replay/append critical section은 resource ID에서 파생한 `FileRunControl` lease로 직렬화한다. 이 metadata lease는 PID와 process incarnation을 검증하는 기존 stale recovery를 재사용한다.
- FIFO ticket과 active lease는 immutable event replay에서만 계산한다. active lease가 있으면 뒤 request는 acquire할 수 없다. 서로 다른 resource ID는 독립적으로 진행한다.

### Workflow Journal과 복구 경계

- global resource journal은 shared operational coordination state다. Run outcome의 권위는 계속 parent/child JSONL Journal이다.
- resource owner HoneyBee process가 종료됐다는 이유만으로 active lease를 자동 탈취하거나 release하지 않는다. 기록된 Agent/TestPlay/Unity descendant가 workspace를 사용 중일 수 있기 때문이다.
- parent `run resume`은 기존 child recovery barrier를 유지한다. child의 unmatched process tree를 먼저 drain하고 durable drain marker를 남긴 뒤, child Journal의 request/ticket/lease identity와 global journal을 정확히 대조한다.
- child Journal에 acquire marker가 없으면 durable queued request는 cancel한다. coordinator acquire가 먼저 durable해진 crash window라면 matching active lease를 release한다. child Journal에 acquired marker가 있으면 matching active/released lease만 인정하고 explicit release를 완료한다.
- child가 queued/acquired를 증명하지만 global history가 missing 또는 mismatched이면 workspace를 release하지 않고 `cleanup-pending`을 유지한다. global release가 성공하고 child marker 기록 전에 다시 종료돼도 다음 resume은 matching released identity를 재사용한다.
- automatic retry/resume은 추가하지 않는다. 운영자가 parent Run에 `run resume`을 호출한다.

### Durability와 lifecycle

- 보장은 HoneyBee/Agent/adapter process crash 및 강제 종료 뒤의 event consistency와 explicit recovery를 대상으로 한다.
- 갑작스러운 전원 차단, OS crash, filesystem/controller cache를 포함한 완전한 power-loss durability는 보장하지 않는다.
- terminal Run 삭제 후 resource event history와 temporary 잔여 데이터의 compaction/GC는 이번 범위가 아니다. active lease는 child Run이 terminal이 되기 전에 반드시 닫히므로 Run 삭제가 resource ownership을 제거하는 수단이 되지 않는다.

## 결과

동일한 state root를 쓰는 독립 HoneyBee batch process는 capacity-1 Unity 자원을 durable FIFO로 공유한다. process crash가 queue 순서나 active ownership을 지우지 않으며, v0.4에서 확립한 process drain과 workspace release 순서도 유지된다. config schema 1 사용자는 기존 process-local 의미를 그대로 얻는다.

## 비범위

- Git Worktree 생성·적용·merge
- capacity 1을 넘는 semaphore
- distributed coordinator, daemon 또는 scheduler
- 자동 retry/restart resume
- GUI, Semantic IR, Recipe 시스템
- 여러 Agent가 하나의 Work를 공동 수행하는 orchestration
