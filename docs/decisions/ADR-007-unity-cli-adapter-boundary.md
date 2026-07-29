# ADR-007: Unity CLI Adapter 경계

- 상태: 승인, 구현은 유예
- 결정일: 2026-07-29

## 맥락

SRS는 공식 Unity CLI를 기본 실행·제어 인터페이스로 사용하고 실험적 변경을 Adapter 뒤에 감추도록 요구한다. 기술 아키텍처 v0.2는 공식 Unity CLI, 얇은 C# UPM Bridge, testplay-runner와 정적 도구를 각각 TypeScript Adapter로 연결하도록 한다.

Unity 버전, 설치 경로, flag, exit code와 출력 형식이 Application/Domain에 누출되면 Unity 변경 때 제품 전체가 흔들리고 잘못된 Workspace를 대상으로 명령을 실행할 위험이 커진다.

## 결정

Unity 기능은 use case 중심의 `UnityCommandPort`와 구체 `UnityCliAdapter` 사이에 격리한다.

현재 Vertical Slice는 Port·fixture 경계만 유지하며 실제 Unity executable 호출, C# Bridge와 testplay 통합은 구현하지 않는다.

### Port

- 등록된 command identifier와 typed input/output만 노출한다.
- project/workspace identity, timeout, cancellation을 명시한다.
- compile failure, test failure, timeout, invalid project, unsupported capability 같은 안정적인 error code를 반환한다.
- Unity executable 경로, CLI flag, stdout 문구를 Domain에 노출하지 않는다.
- 임의 문자열 command 또는 unrestricted eval을 기본 계약으로 제공하지 않는다.

### UnityCliAdapter

- Workspace root와 Unity 버전/설치 경로를 검증한다.
- shell 문자열이 아닌 executable + argv 배열을 구성한다.
- Windows path/quoting, environment, timeout과 cancellation을 처리한다.
- exit code와 stdout/stderr 또는 JSON을 versioned schema로 검증한다.
- Unity별 오류를 Honey Bee 표준 Result/Error로 변환한다.
- capability와 version 차이를 Adapter 내부에서 탐지한다.
- 원본 출력은 Artifact 경로로 보존할 수 있지만 대용량 blob을 Domain result에 넣지 않는다.

### C# UPM Bridge

- Unity Editor 내부 API가 필요한 등록된 안전 명령을 노출한다.
- compile/import/play mode, console summary 같은 구조화 상태를 반환한다.
- Scene, Prefab, Asset 딥링크와 선택을 담당한다.
- versioned JSON schema와 안정적인 error code를 사용한다.
- Session, Workspace orchestration, cache, permission policy를 구현하지 않는다.

testplay-runner, unity-ctx, fileID graph는 하나의 거대한 Unity Adapter에 합치지 않고 각 도구의 Port/Adapter와 계약 테스트를 유지한다. Application use case가 필요한 조합을 조정한다.

## 결과

### 긍정적

- Unity CLI 변경과 C# API가 제품 Domain에서 격리된다.
- Fake executable과 fixture JSON으로 대부분의 실패를 Unity 설치 없이 테스트할 수 있다.
- 잘못된 Workspace 실행과 unrestricted eval을 경계에서 차단할 수 있다.
- 독립 도구를 재작성하지 않고 유지할 수 있다.

### 비용과 제한

- CLI/Bridge schema version과 fixture 유지가 필요하다.
- Unity license가 필요한 end-to-end 테스트는 별도 환경이 필요하다.
- 기능별 Adapter가 늘어날 수 있으므로 명확한 capability naming이 필요하다.

## 검토한 대안

### Application에서 Unity CLI를 직접 spawn

argv, exit code, 출력 파싱이 use case에 퍼지고 fixture 재사용이 어렵다. 채택하지 않는다.

### 모든 Unity 기능을 C# Bridge에 구현

비즈니스 정책과 Workspace 상태가 Unity process에 결합된다. Bridge를 얇게 유지한다.

### unrestricted eval을 공통 탈출구로 제공

버전 호환성과 권한·감사 가능성을 약화한다. 별도 고위험 capability가 명시적으로 승인될 때만 재검토한다.

### 기존 Go 도구를 TypeScript로 재작성

안정된 코어를 다시 검증해야 하고 현재 목적과 무관하다. versioned JSON Adapter로 연결한다.

## 구현 전 검증 항목

- Fake executable로 argv, cwd, environment, timeout 검증
- 성공, compile failure, test failure, malformed JSON, non-zero exit fixture
- Unity version/capability mismatch
- 요청 Workspace와 열린 Editor Workspace 불일치 차단
- cancellation 뒤 child process 정리
- C# Bridge schema 호환성과 unknown field/version 처리
- unrestricted eval이 기본 Tool Profile과 Port에 노출되지 않음

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-003](ADR-003-pty-structured-events.md)
- [ADR-006](ADR-006-library-image-storage-driver.md)
- [ADR-002](ADR-002-typescript-first.md)
