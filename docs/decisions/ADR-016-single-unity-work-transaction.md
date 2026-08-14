# ADR-016: Single Unity Work Transaction

## 상태

Accepted for HoneyBee v0.4.

## 배경

v0.3의 DAG kernel은 Agent process, Artifact Store, JSONL Journal과 executor lease를 제공하지만 Unity workspace의 생성·검증·회수는 다루지 않는다. v0.4의 목표는 기능을 일반화하는 것이 아니라 원본 Unity project를 변경하지 않는 단일 작업 bracket을 증명하는 것이다.

대상 storage provider는 `Kubonsang/unity-workspace-storage`의 public contract schema 1이다. 구현 기준은 commit `575c3b37896cd3dfa37a4705477837cc52ec6132`로 고정한다. parent construction과 broker administration은 public `acquire/status/release` lifecycle 밖의 operator 책임이다.

Unity config는 위 commit을 literal `contractCommit`으로 요구하고 absolute storage executable의 `binarySha256`를 모든 public operation 전에 검증한다.

## 결정

v0.4는 다음 순서만 제공한다.

```text
prepare
→ acquire
→ one Agent
→ TestPlay
→ Evidence
→ release
→ residual 0
```

### 책임 경계

- `apps/cli`의 Unity bootstrap이 `Assets`, `Packages`, `ProjectSettings`를 broker-owned shell에 물리 복사한다.
- shell 준비는 Core public workspace abstraction으로 일반화하지 않는다.
- bootstrap은 symlink/reparse entry를 거부하고 acquire 전에 `Library`가 없음을 확인한다.
- source, broker workspace root, HoneyBee Run root는 기존 ancestor의 real path를 포함한 physical path 기준으로 서로 겹치지 않아야 한다.
- external `file:` package staging은 구현하지 않으며 `localPackagesDigest` parent는 fail-closed한다.
- `unity-workspace-storage` adapter는 public schema 1의 `acquire/status/release`만 사용한다. 내부 broker protocol, heartbeat, retain, GC와 parent build를 사용하지 않는다.
- Agent와 TestPlay는 획득한 같은 project shell을 cwd/project path로 사용한다.
- TestPlay는 `--no-bridge`로 실행하고 별도의 HoneyBee shadow workspace를 만들지 않는다.
- 기존 DAG scheduler와 `DagOrchestrationWorkflow`는 변경하지 않는다.

### Durability

Unity transaction은 Journal schemaVersion 3을 사용한다. schemaVersion 1과 2 Run은 기존 의미를 유지한다.

- `workspace.acquired`가 fsync되기 전에는 Agent를 실행하지 않는다.
- storage가 lease를 반환한 뒤 receipt Artifact 또는 `workspace.acquired` 기록이 실패하면 acquire failure로 확정하지 않는다. 동일 acquire request로 lease identity를 복구할 수 있도록 Run을 `cleanup-pending`으로 유지한다.
- TestPlay Evidence는 Artifact Store에 publish된 뒤에만 `testplay.verified`가 기록된다.
- semantic outcome은 release보다 먼저 `transaction.outcome-decided`로 확정한다.
- terminal workflow event는 `workspace.released` 이후 Journal의 마지막 event로만 기록한다.
- 실패와 cancel은 Agent와 TestPlay의 전체 process tree를 drain한 뒤 원래 AbortSignal과 분리된 cleanup path에서 release한다.
- `agent.started`와 `testplay.started`는 가능한 경우 PID와 process incarnation을 함께 기록한다. Resume은 대응하는 exit가 없는 동일 incarnation의 Windows process tree를 먼저 drain하며, 성공하면 해당 started event를 가리키는 `process.drain-completed`를 기록한다. 이후 resume은 이 durable marker를 재사용한다. 안전하게 식별하거나 종료할 수 없으면 release하지 않고 `cleanup-pending`을 유지한다.
- release 실패 또는 응답 유실은 terminal failure가 아니다. Run은 `cleanup-pending`으로 남는다.
- `run resume`는 같은 release request ID로 cleanup만 복구하며 Agent와 TestPlay를 재실행하지 않는다.
- nonterminal Unity Run과 Journal이 손상된 모든 `indeterminate` Run은 `run delete`로 제거할 수 없다.
- acquire 응답이 불확실하면 같은 acquire request ID로 lease 응답만 복구한 후 interrupted/cancel outcome으로 release한다. 일반 workflow retry로 취급하지 않는다.

HoneyBee/Agent/adapter process crash와 강제 종료 이후 Journal consistency와 cleanup recovery를 대상으로 한다. 전원 차단, OS crash 및 storage controller cache를 포함한 완전한 power-loss durability는 보장하지 않는다.

### Evidence와 원본 보호

source의 세 project directory에 대한 SHA-256 manifest를 transaction 전후로 계산한다. 각 path와 content는 byte length로 frame하여 tree serialization의 경계를 모호하지 않게 한다. 두 manifest가 다르면 `source.modified`로 fail-closed한다. Resume 시 source를 읽을 수 없어도 failed outcome을 확정한 뒤 release를 계속 시도한다.

`completed` outcome은 TestPlay Evidence가 검증되고 source manifest가 unchanged로 확인된 뒤에만 유효하다. Journal replay는 terminal failure metadata와 Evidence/source/release Artifact reference를 각각 durable decision과 선행 event에 대조하며, 불일치하면 corruption으로 거부한다.

release 전에 다음 TestPlay 파일을 HoneyBee Artifact Store로 가져온다.

- `results.xml`
- `summary.json`
- `manifest.json`
- `stdout.log`
- `stderr.log`
- `events.ndjson`

TestPlay config는 Run별 reserved path에 exclusive create하며 기존 file, hard link 또는 reparse entry를 덮어쓰지 않는다. Evidence는 private regular file만 허용하고 파일당 16 MiB, transaction당 총 32 MiB까지만 bounded read한다. Evidence body와 source/workspace path는 Journal에 기록하지 않는다. Journal은 typed process metadata와 Artifact reference만 보유한다.

### residual 0

모든 production transaction은 release response의 `cleanupState`가 `released`이고 transaction shell이 사라졌음을 확인한다. 격리된 E2E는 추가로 다음 provider status를 모두 0으로 확인한다.

- `activeChildCount`
- `retainedChildCount`
- `pendingCount`
- `quarantineCount`

immutable parent count와 parent allocated bytes는 operator-owned cache이므로 residual에 포함하지 않는다.

## 결과

v0.4는 Unity-specific bootstrap과 external CLI details를 adapter에 격리하면서 기존 Artifact, Journal, RunRepository와 executor lease를 재사용한다. release가 확인되지 않은 Run은 성공 또는 실패로 닫히지 않으므로 잔여 workspace가 terminal result 뒤에 숨지 않는다.

## 비범위

DAG 변경, 다중 Unity Agent, parallel execution, scheduler, retained workspace, provider selection/fallback, parent provisioning, GUI, Semantic IR, warm-editor bridge, TestPlay shadow/scenario orchestration은 포함하지 않는다.
