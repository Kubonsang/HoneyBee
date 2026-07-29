# ADR-001: Windows-first 지원 정책

- 상태: 승인
- 결정일: 2026-07-29
- 적용 범위: v0.x~v1.0 초기 구현과 CI

## 맥락

SRS v0.1은 Windows, macOS, Linux를 운영 환경으로 열거한다. 반면 기술 아키텍처 v0.2와 사용자 확정 범위는 Windows 기반 Unity 개발을 우선하고 초기 릴리스에서 교차 플랫폼 구현·CI 비용을 지불하지 않도록 한다.

현재 Vertical Slice의 핵심 위험도 Windows ConPTY, `node-pty`, 프로세스 종료와 경로·인용 처리다. 교차 플랫폼 추상화를 동시에 구현하면 이 위험을 분리해 검증하기 어렵다.

## 결정

현재 공식 지원과 필수 CI를 Windows 11로 한정한다.

- Windows 11 로컬 환경과 Windows CI만 릴리스 차단 기준으로 사용한다.
- PTY Adapter는 ConPTY 동작을 기준으로 구현·검증한다.
- 경로, 프로세스, signal/interrupt, shell 인용 정책은 Windows 의미를 명시적으로 사용한다.
- macOS, Linux, WSL, 원격 Workspace는 현재 비범위다.
- Domain과 Port에는 불필요한 Win32 타입을 넣지 않지만, 아직 사용하지 않는 OS Adapter나 공통 최저 기능 추상화를 만들지 않는다.
- 지원 OS 확대는 별도 ADR과 해당 OS의 CI, PTY, 경로, 프로세스 fixture를 동반해야 한다.

## 결과

### 긍정적

- ConPTY와 Windows process lifecycle에 테스트와 디버깅을 집중할 수 있다.
- 초기 PR과 CI matrix가 작아진다.
- Unity 사용자의 우선 환경에서 빠르게 Vertical Slice를 검증할 수 있다.

### 비용과 제한

- SRS v0.1의 다중 OS 문구는 현재 릴리스 수용 기준으로 사용할 수 없다.
- POSIX signal, pty, path 동작은 검증되지 않는다.
- Windows 전용 선택이 소스에 퍼지지 않도록 Adapter 경계와 import 검사가 필요하다.

## 검토한 대안

### 처음부터 3개 OS 지원

제품 비전에는 부합하지만 현재 슬라이스에서 PTY와 packaging 위험을 세 배로 늘린다. 채택하지 않는다.

### Linux를 개발 기준으로 두고 Windows만 배포

ConPTY, Windows quoting, Unity 설치 탐지의 실제 위험을 늦춘다. 채택하지 않는다.

### 완전한 OS 추상화를 먼저 설계

실제 두 번째 OS use case 없이 잘못된 공통 분모를 만들 가능성이 크다. 최소 Port만 기술 중립적으로 유지한다.

## 검증

- Windows runner에서 build, unit, IPC, PTY 통합 테스트가 통과한다.
- 문서와 설치 UI가 macOS/Linux를 지원 대상으로 표시하지 않는다.
- Domain package에서 Win32, VS Code, `node-pty` import가 발견되지 않는다.
- 새로운 OS 조건 분기가 추가되면 Adapter 내부인지 검토한다.

## 재검토 조건

- Windows Vertical Slice가 안정화되고 다른 OS 수요가 확인됨
- 해당 OS용 PTY, process, path, Unity fixture와 CI owner가 준비됨
- Port 변경 없이 Adapter 추가가 가능한지 검증할 수 있음

## 관련 문서

- [초기 아키텍처](../architecture/initial-architecture.md)
- [ADR-005](ADR-005-extension-host-runtime-boundary.md)
