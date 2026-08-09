# ADR-014: Strict Sequential Orchestration Kernel and Artifact Journal

- 상태: 승인
- 기준일: 2026-08-09
- 관련 결정: ADR-013

## 배경

ADR-013은 두 실제 CLI 프로세스 사이의 handoff를 증명했다. 다음 단계에는 producer/reviewer 문자열 역할을 확장 가능한 step 계약으로 바꾸되, DAG나 재시작 복구를 도입하지 않는 작은 kernel이 필요하다. 자유 형식 stdout과 메타데이터만 남기는 로그로는 Agent 결과의 의미, handoff 입력, crash 이후 확정 가능한 상태를 엄격하게 설명할 수 없다.

## 결정

### 순차 workflow

- Core는 config에 선언된 두 개 이상의 step을 배열 순서대로 실행한다.
- 모든 Agent 통신은 HoneyBee를 경유한다.
- Agent 입력과 출력은 versioned Zod contract로 검증한다.
- exit code 0은 process lifecycle 성공만 뜻한다. 업무 결과는 `step.completed`, `step.blocked`, `step.escalated`, `step.failed`가 결정한다.
- DAG, 병렬 실행, retry와 restart resume는 구현하지 않는다.

### 식별자와 입력

- `RunId`와 `ArtifactId`는 UUID branded type이다.
- `StepId`는 `^[a-z][a-z0-9_-]{0,63}$`이며 config 안에서 고유하다.
- filesystem API는 raw CLI 문자열을 받지 않는다.
- Core는 task와 직전 step-content Artifact를 read+verify한 뒤 `AgentInputEnvelopeV1`을 생성한다.
- 검증·직렬화된 정확한 JSON bytes를 `step-input` Artifact로 저장하고 `artifact.stored`를 flush한 뒤 Agent를 시작한다.
- 다음 step도 메모리 사본이 아니라 Artifact Store에서 입력을 다시 읽는다.

### Artifact identity와 publish

- `artifactId`는 논리 ID이며 파일명이나 digest가 아니다.
- `contentDigest`는 exact UTF-8 bytes의 `sha256:<64 lowercase hex>`다.
- blob 경로는 digest hex만 사용한다. 같은 run의 서로 다른 Artifact ID가 같은 blob을 공유할 수 있다.
- publish는 same-volume temporary file과 hard-link no-clobber를 사용한다. `EEXIST`는 기존 blob을 검증한 뒤에만 dedup 성공으로 처리한다.
- rename overwrite나 unsafe fallback은 허용하지 않는다.
- 모든 `get()`은 실제 bytes의 길이와 digest를 다시 계산한다. 불일치는 `artifact.integrity-failed`다.

### 책임 경계

- `RunRepository`는 run directory 생성, 조회, 전체 삭제를 소유한다.
- `ArtifactStore`는 Artifact put/get과 blob 무결성을 소유하며 run 삭제를 하지 않는다.
- `Journal`은 strict event append, flush와 replay만 소유한다.
- Artifact 원문은 JSONL에 저장하지 않는다. journal은 typed metadata와 ArtifactRef만 기록한다.

### Journal 보안과 terminal 불변식

- Journal writer는 strict `OrchestrationEventV1`만 받는다.
- generic Error serialization과 Core error details spread를 금지한다.
- stdout, stderr, prompt, task, content, reason, question 원문은 event payload에 허용하지 않는다.
- process 오류에는 `errorCode`, `exitCode`, `signal`, `durationMs`, `stdoutBytes`, `stderrBytes`처럼 allowlist된 metadata만 기록한다.
- terminal workflow event는 `completed`, `blocked`, `escalated`, `failed` 중 정확히 하나이며 마지막 유효 event여야 한다.
- terminal 이후 event, sequence 오류, malformed frame, schema 또는 run ID 불일치, terminal 부재는 `indeterminate`다.
- orphan blob은 run 상태에 영향을 주지 않는다. Journal만이 run 상태의 권위다.
- terminal journal이 유효한데 Artifact가 손상된 경우 journal 상태는 유지하고 Artifact read만 실패한다.

## Persistence 순서

정상 step은 다음 barrier를 지킨다.

1. `step.assigned`
2. task/previous Artifact read와 무결성 검증
3. Agent input 생성·검증·직렬화
4. `step-input` blob publish
5. `artifact.stored` append+flush
6. process spawn과 `agent.started` append+flush
7. stdin 전달
8. process 종료와 `agent.exited` append+flush
9. Agent response 검증
10. semantic Artifact publish와 `artifact.stored` append+flush
11. `step.completed|blocked|escalated`
12. 마지막 step이면 terminal workflow event

Process, protocol 또는 Artifact 실패는 journal이 사용 가능할 때 `step.failed`와 마지막 `workflow.failed`를 기록한다. Journal append/flush가 실패하면 즉시 실행을 중단하고 terminal 결과를 추론하지 않는다.

## Crash model

v0.2 durability는 HoneyBee process crash, Agent process crash와 강제 종료 후 journal이 증명할 수 있는 상태를 대상으로 한다. 각 successful append+flush는 다음 상태 전이의 persistence barrier다.

갑작스러운 전원 차단, OS crash, filesystem 손상, storage controller cache 유실까지 포함하는 완전한 power-loss durability는 보장하지 않는다. 재시작 후 자동 resume, retry 또는 미완료 작업 재실행도 범위 밖이다.

## 호환성

CLI loader는 schemaVersion 1의 producer/reviewer를 각각 같은 ID의 두 v2 step으로 변환한다. Core는 canonical v2 workflow만 받는다. 공식 예제와 문서는 v2를 사용하며 v1 형식에는 새 기능을 추가하지 않는다.

## 결과

HoneyBee v0.2는 작은 sequential orchestration kernel로 닫힌다. 이후 기능은 이 계약의 ID, Artifact, event와 terminal 의미를 깨지 않는 별도 결정으로만 추가한다.
