# ADR-019: Unity Editor Pool, Ownership, and Capabilities

## 상태

Accepted for HoneyBee v0.6.

## 배경

v0.5는 여러 Unity Work의 Agent 단계를 병렬로 실행하고 TestPlay 같은 공유 단계를 durable resource lease로 직렬화했다. 그러나 실제 Unity 운영에서는 실행 중인 Editor의 PID incarnation, workspace 소유권, Warm Bridge binding, Editor slot 부족 대기, 그리고 compile/warm-test 실행 순서를 하나의 안전한 lifecycle로 묶어야 한다. 사용자 Editor를 자동으로 채택하거나 종료해서는 안 되며, v0.4/v0.5의 source 불변성과 cleanup-pending semantics도 유지해야 한다.

## 결정

### 계약 버전과 호환성

- v0.6 single Work는 strict config schema 2, v0.6 batch는 strict config schema 3, parent/child Journal은 schema 5를 사용한다.
- v0.5 batch schema 1/2, v0.4 Work schema 1, DAG/sequential 계약은 변경하지 않는다.
- v0.6 batch의 child는 schema 2 Work config로 변환되며 priority와 ordered capabilities는 parent config가 소유한다.

### Editor pool

- 전역 coordinator가 관리하는 resource는 Editor pool 하나뿐이다.
- Work는 slot이나 Editor를 직접 선택하지 않는다. pool은 interactive, validation, background 순으로 우선순위를 적용하고 같은 priority에서는 durable FIFO로 free slot을 배정한다.
- pool capacity는 1에서 32까지 명시적으로 설정한다. slot ID는 editor-1 같은 안정된 이름이다.
- active lease preemption은 금지한다. 서로 다른 slot/workspace는 병렬일 수 있지만 하나의 assigned slot은 child Run이 독점한다.
- warm-bridge:<editorId>, testplay:<editorId>, compile별 별도 resource lease는 만들지 않는다. compile과 warm-test는 독점 slot을 가진 child 안에서 직렬 실행한다.

### Registry와 ownership

- OS Editor Registry는 발견 사실을, durable ownership registry는 HoneyBee ownership을 기록한다. Bridge binding은 별도 계약이다.
- HoneyBee-owned Editor는 PID와 process creation identity, editorId, launchId, Run/Work, workspaceId/projectPath, pool/slot linkage를 모두 일치시켜야 한다.
- projectPath를 확정한 비소유 Editor는 user-owned, 확정하지 못한 Editor는 unknown으로 관찰한다. 두 경우 모두 lease, adoption, activation, termination 대상이 아니다.
- stale/crashed owned Editor는 exact PID incarnation과 durable containment 경계로만 정리한다.

### Launch crash boundary

- editor launch intent, containment receipt, ownership receipt는 서로 다른 immutable Artifact다.
- intent는 pinned Unity executable digest, assigned pool lease/slot, workspace, launchId, 256-bit nonce, timeout과 receipt path를 기록한다.
- sanitized internal environment에서 시작한 containment launcher가 자신의 PID/process creation identity와 launchId/nonce를 durable no-overwrite receipt로 직접 publish하고 다시 읽어 검증한 뒤 ready를 반환한다.
- HoneyBee는 receipt의 파일 identity, 크기, digest, PID incarnation 및 intent 상관관계를 검증하고 artifact.stored와 editor.containment-registered를 fsync한 뒤에만 activation한다.
- ownership receipt는 activation 후 실제 Editor PID/incarnation과 direct containment parent 관계가 확인된 뒤 별도로 기록한다.
- ownership 확정 전 crash recovery는 Editor PID를 직접 종료하지 않고 durable containment tree만 drain한다.

### Bridge와 capability

- Warm Bridge protocol 3 binding은 exact owned editorId/PID/incarnation, workspaceId/projectPath, bridge session, idle state와 fresh heartbeat를 검증한다.
- Bridge는 binding과 identity만 담당하며 scheduling, lease, Editor lifecycle을 소유하지 않는다.
- Agent는 Unity lifecycle이나 capability를 선택하지 않는다. HoneyBee config가 compile과 warm-test의 strict ordered list를 선언한다.
- 각 capability 전후에 Bridge identity를 재검증한다. capability process lifecycle과 bounded Evidence는 schema 5 Journal metadata 및 content-addressed Artifact에 남긴다.
- capability Evidence는 TestPlay protocol 3 응답의 capability, Editor/workspace/session binding, process exit, artifact root가 durable summary/manifest와 일치할 때만 승인한다. warm-test 성공은 exit code 0뿐 아니라 실행된 test total이 1 이상이어야 한다.

### 복구와 cleanup

- recovery는 Agent나 capability를 자동 재실행하지 않는다. unmatched child process incarnation은 drain 후 interrupted failure로 확정한다.
- containment/ownership 상태를 replay하고, containment drain과 Editor exit를 pool release보다 먼저 완료한다.
- pool release 뒤 원본 source manifest를 다시 검증하고 verified patch manifest와 content-addressed file Artifacts를 보존한 뒤 workspace를 release한다.
- terminal event는 workspace.released 이후에만 기록한다. release 또는 containment 정리를 증명하지 못하면 cleanup-pending이며 Run 삭제를 거부한다.
- durability 목표는 HoneyBee/Agent/adapter process crash 및 강제 종료 후 consistency다. 완전한 power-loss durability와 자동 restart resume은 보장하지 않는다.

### 관찰성

- run show는 Waiting for Editor, editor-N leased, Warm Bridge ready, 현재 capability 같은 child phase를 표시한다.
- unity editor list는 owned/user/unknown 관찰을 모두 보여주되 user/unknown에 ownership linkage를 부여하지 않는다.

## 결과

여러 isolated Unity Work의 Agent 단계는 병렬로 실행할 수 있고, pool capacity 안에서 서로 다른 Editor/workspace도 병렬로 검증할 수 있다. 같은 slot은 priority/FIFO queue로 직렬화된다. HoneyBee가 소유하지 않은 Editor는 관찰만 되며, crash/cancel recovery는 containment, pool, workspace 순서로 residual zero를 지향한다.

## 비범위

- capture/GPU capability와 scheduling
- GUI
- Semantic IR
- Recipe 시스템
- Git Worktree 통합
- distributed worker/coordinator
- running lease preemption
- capacity 자동 최적화
- capability retry 또는 자동 restart resume
