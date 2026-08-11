# ADR-015: Durable DAG Orchestration Kernel

- 상태: 승인
- 기준일: 2026-08-11
- 관련 결정: ADR-014

## 배경

ADR-014의 순차 kernel은 Agent 입력·출력을 immutable Artifact로 보존하고 JSONL Journal만을 Run 상태의 권위로 삼았다. v0.3은 이 무결성 경계를 유지하면서 dependency graph, 제한된 병렬 실행, 사람이 개입하는 nonterminal 상태와 restart recovery를 제공해야 한다.

## 결정

### Config와 graph

- Canonical config는 strict `WorkflowConfigV3`다. v1/v2 config는 `maxParallelism: 1`인 선형 v3 DAG로 변환하되, 기존 Agent에는 `stdio-framed-v1` compatibility harness로 `AgentInputEnvelopeV1`/response v1 계약을 유지한다.
- Agent는 executable profile이고 Harness는 process communication 방식이다. Step은 두 branded ID를 독립적으로 참조한다.
- `needs` control edge, named Artifact input edge, condition reference를 합친 graph가 acyclic이어야 한다.
- 여러 root/leaf, fan-out과 fan-in을 허용한다. ready step 선택은 Step ID 순으로 결정하며 동시에 실행하는 Agent attempt는 `maxParallelism`을 넘지 않는다.
- 결과 집계·비교·선택은 여러 Artifact input을 받는 일반 Agent step이 담당한다.
- CLI 편의 `result`는 config의 `outputs.result`가 특정 step output을 명시적으로 가리킬 때만 제공한다. binding이 없으면 모든 step output Artifact는 보존하되 config 배열 순서로 임의 leaf를 선택하지 않는다.

### Artifact와 조건

- v3 Agent 입력은 named input port와 required output port/media type을 함께 가진 `AgentInputEnvelopeV2`다. 모든 source Artifact는 각 attempt 전에 Store에서 다시 읽고 length/digest를 검증한다.
- Agent는 선언된 output port와 media type을 정확히 반환해야 한다. partial publish된 Artifact는 `step.completed`가 output map을 확정하기 전까지 step 결과가 아니다.
- v0.3 Agent payload는 UTF-8 text와 JSON만 지원한다.
- 조건은 step outcome 또는 JSON Artifact의 RFC 6901 pointer를 대상으로 하는 제한식 DSL이다. 임의 코드 실행은 허용하지 않는다.

### 실행과 실패

- independent ready branch는 병렬 실행한다. 한 step의 최종 실패는 required descendant만 skip하고 독립 branch는 계속 실행한다.
- workflow terminal 우선순위는 `failed > escalated > blocked > completed`다. 명시적 cancel은 `workflow.cancelled`다.
- retry는 step별 `maxAttempts`와 allowlist된 error/exit/timeout에만 적용한다. jitter 없는 exponential backoff의 `notBefore`를 Journal에 기록한다.
- timeout은 attempt별이며 step 설정이 workflow 기본값보다 우선한다.
- `agent.exited`는 OS lifecycle 사실이고 `step.completed|blocked|escalated|failed`가 semantic outcome을 결정한다.

### Single writer와 control

- 하나의 executor lease만 Run Journal을 기록한다. owner는 PID와 OS process creation identity를 함께 기록하며 둘이 일치할 때만 같은 live executor로 판단한다. 완성된 ownership directory를 atomic publish하고, stale lease는 관측한 lease ID별 tombstone으로 atomic 이동해 takeover 경쟁자가 새 live lease를 제거하지 못하게 한다. Run 삭제도 같은 lease를 획득한 동안 수행한다.
- pause, cancel, approval, interrupted resolution 명령은 원자적 control inbox에 UUID request로 저장한다.
- inbox와 lock은 운영 수단일 뿐 Run 상태의 권위가 아니다. executor가 `control.accepted`를 flush한 뒤에만 요청에 semantic 의미가 생긴다.
- control CLI는 executor 유무의 관측 snapshot을 응답한다. executor가 없으면 요청은 `queued-awaiting-executor`이며 사용자가 `run resume`을 실행할 때까지 inbox에 대기한다.
- pause는 새 scheduling을 막고 in-flight attempt가 끝난 checkpoint에서 `workflow.paused`가 된다.
- approval은 Agent를 실행하지 않는 step이다. approve/reject 모두 JSON decision Artifact를 출력하며 조건 branch가 후속 경로를 선택한다.
- cancel은 새 scheduling을 막고 in-flight process에 종료 신호를 보낸 뒤 bounded grace 후 강제 종료한다.

### Replay와 interrupted attempt

- Journal event schema v2는 paused, waiting-approval, retry-wait와 interrupted를 정상 nonterminal 상태로 허용한다.
- resume은 config/task Artifact와 Journal을 replay하여 completed step을 다시 실행하지 않고 pending graph와 retry deadline을 복원한다.
- `agent.started` 이후 semantic outcome이 확정되지 않은 attempt는 `interrupted`다. 외부 side effect 중복을 막기 위해 자동 retry하지 않고 사용자가 retry 또는 fail로 해소한다.
- terminal workflow event는 정확히 하나이며 마지막 유효 event여야 한다. malformed frame, sequence 오류, mixed schema, 불가능한 상태 전이와 terminal 이후 event는 `indeterminate`다.
- orphan blob과 아직 수락되지 않은 control request는 `indeterminate`의 근거가 아니다.

## Persistence barrier

정상 Agent attempt는 source Artifact read+verify, `step-input` publish, `artifact.stored`, `step.attempt.started`, `step.assigned`, `agent.started`, stdin 전달, `agent.exited`, response 검증, output publish와 `artifact.stored`, `step.completed` 순서를 지킨다. 모든 Journal append는 다음 side effect 이전에 flush한다.

## Crash model과 범위

durability는 HoneyBee/Agent process crash와 강제 종료 후 Journal consistency를 대상으로 한다. 갑작스러운 전원 차단, OS/filesystem/storage-controller failure까지 포함한 완전한 power-loss durability는 보장하지 않는다.

v0.3은 local CLI executor다. daemon, distributed worker, arbitrary condition code, binary Agent protocol, uncertain attempt의 자동 재실행, PTY/TUI orchestration과 Unity/testplay 통합은 포함하지 않는다.

## 결과

HoneyBee v0.3은 v0.2의 strict persistence 경계를 깨지 않고 작은 durable DAG orchestration kernel을 제공한다. 기존 sequential workflow는 같은 CLI에서 선형 DAG로 계속 실행된다.
