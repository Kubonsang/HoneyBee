# Ashen Crossing comparison protocol v2

## Purpose

Measure whether HoneyBee's four-agent topology improves delivery of a quality-first MMORPG
tutorial vertical slice when the harness, reference, acceptance gates, and compute accounting are
made explicit. This supersedes the quality conclusion of the earlier Frontier Siege trial.

This is a single controlled trial, not a statistically powered benchmark.

## Conditions

Four independent copies of the same pre-warmed Unity 6000.3.10f1 URP baseline are used:

1. `controlled-multi`: HoneyBee Codex app-server adapter, three parallel builders followed by one
   unrestricted final owner.
2. `controlled-single`: the same HoneyBee Codex app-server adapter, one unrestricted owner.
3. `e2e-honeybee`: the shipping HoneyBee workflow, three parallel builders followed by one final
   owner. Only product-supported patch application and one predefined retry are allowed.
4. `e2e-direct`: normal `codex exec`, one unrestricted owner.

The controlled comparison may normalize the already-verified HoneyBee response envelope and compose
verified, disjoint file payloads path-by-path. Every normalization is logged. The end-to-end
comparison forbids hidden manual source repair.

## Time and compute views

- Same-wall view: compare the best accepted state at 15 wall-clock minutes.
- Same-compute view: compare the best accepted state at 27 agent-minutes.
- Multi-agent budget: builders are capped conceptually at 6 minutes each, final owner at 9 minutes.
- Single-agent budget: preserve a 15-minute checkpoint and allow the same session to continue to
  27 minutes.
- Actual observed agent-seconds are reported even when an agent finishes early.

The harness never awards quality for unused time. Work that exists at the checkpoint is evaluated.

## Inputs held constant

- `BENCHMARK_SPEC.md`
- `common/ashen-crossing-concept.png`
- blank Unity baseline and pre-warm procedure
- Unity editor version and target
- automatic rubric and acceptance scripts
- screenshot resolution and capture method
- no external packages, downloaded assets, or manual source edits

## Builder topology

The HoneyBee multi-agent conditions use exactly four agents:

1. Systems builder owns `Systems/**` and its tests.
2. Presentation builder owns `Presentation/**`, `Resources/**`, and its tests.
3. Runtime builder owns `Runtime/**`, integration tests, and README.
4. Final owner runs after the three patches are integrated and may edit all
   `Assets/AshenCrossing/**` implementation files to compile, test, polish, and reconcile the slice.

The final owner is a real integration/art-direction pass, not only a merge reviewer.

## Acceptance and quality

Hard gates:

- zero C# compiler errors
- at least 30 passing EditMode tests
- successful StandaloneWindows64 build
- exact ready, autoplay completion, and reset markers in order
- no managed exception in the validated Player log
- visible 1280x720 gameplay screenshot

Automatic score (100):

- function and progression: 30
- visual clarity and MMORPG tutorial feel: 25
- UX/onboarding feedback: 15
- architecture and maintainability: 10
- tests/runtime reliability: 15
- documentation: 5

Automatic evidence is complemented by a blind user ballot. Final screenshots are randomly mapped to
`A` and `B`; identity is stored separately until the ballot is recorded.

## Resource measurements

For each condition, record:

- wall time to source complete, green tests, successful build, and accepted Player
- sum of child-agent active durations and maximum concurrency
- retries, failed Works, response normalizations, patch conflicts, and correction rounds
- peak HoneyBee/provider/Unity/Player working set
- initial, minimum, and final free disk
- project and `Assets/AshenCrossing` logical/allocated size
- build size, logs, screenshots, runtime journals, HoneyBee setup/VHDX/workspace growth
- source file count, C# lines, and source bytes

Raw measurements are authoritative. Derived tables must cite the raw file names.
