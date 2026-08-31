# Ashen Crossing comparison V2

Measured on 2026-08-30 (Asia/Seoul), Windows 11, Unity 6000.3.10f1. This is one paired trial, not a statistical benchmark.

## Bottom line

The warm end-to-end HoneyBee path produced a tested, buildable artifact with ordered runtime markers in **10m 47.50s**. The direct single-agent path hit its **27m 01.01s** cap without a final response and without tests or documentation. HoneyBee therefore produced the more complete measured artifact at least **16m 13.51s earlier** (60.1% less implementation wall time; at least 2.50x throughput on this trial). This is not a claim of full acceptance: the required autoplay completion/reset within 15 seconds was not measured.

That is not evidence that four agents improve quality by themselves. In the topology-controlled comparison, the multi-agent condition took **9m 17.84s** end to end, versus **5m 38.71s** for the same-adapter single owner, and the multi result did not compile. The single result passed 41/41 tests. The controlled result therefore rejects a simple “more agents = better/faster” claim for the current integration design.

The actual HoneyBee run also did not cleanly aggregate three builders: Presentation applied, while Systems and Runtime were rejected with `<source-manifest>` conflicts. The fourth/final agent reimplemented both missing areas. HoneyBee was fast despite this waste, not because all four outputs composed safely.

## Fairness design

- Four identical pre-warmed copies of the same blank Unity project.
- Identical source manifest after normalizing the four copied `.meta` GUIDs: `c85d40278100470c9e48fcde43b8a27ec0221a740b94ddef59350b74ead24a6d`.
- One shared specification and one shared concept image, SHA-256 `962c878975e014fbbaab358d5bf63ce0e33ae4be351f185acc9df6448194ab46`.
- No source corrections after each condition stopped. Unity validation was external to the agents.
- The four-agent shape was three parallel specialists followed by one serial final owner. The single owner received the whole specification in one prompt.
- The controlled lane used verified, disjoint file composition so topology could be tested without HoneyBee's global-manifest Apply behavior. The end-to-end lane allowed only product Apply behavior.

The exact prompts are in [`prompts/`](prompts/): Systems owned pure systems/tests, Presentation owned world/HUD/shader/tests, Runtime owned gameplay/autoplay/README/tests, and Final Owner owned reconciliation and polish. The direct and controlled single conditions used [`single-owner.txt`](prompts/single-owner.txt).

## Timing

| Condition                                | Agent-active wall | End-to-end implementation wall | Outcome at stop                                                                  |
| ---------------------------------------- | ----------------: | -----------------------------: | -------------------------------------------------------------------------------- |
| Controlled multi: 3 builders + final     |         6m 09.48s |                      9m 17.84s | Hard fail: 3 C# type-contract errors                                             |
| Controlled single, same HoneyBee adapter |         5m 18.98s |                      5m 38.71s | 41/41 tests; build and ordered markers pass; timing unverified                   |
| End-to-end HoneyBee, product Apply only  |         9m 45.22s |                     10m 47.50s | 39/39 tests; build and ordered markers pass; timing unverified                   |
| End-to-end direct Codex                  |        27m 01.01s |                 27m 01.01s cap | Timed out; build and ordered markers pass; 0 tests, no README; timing unverified |

“Agent-active wall” sums the monitored generation phases and excludes integration gaps. “End-to-end implementation wall” runs from the first Work/process launch to applied result or forced cap. Prewarming and external validation are excluded from both.

The end-to-end HoneyBee builder phase consumed **613.87 agent-seconds** in **300.78 wall-seconds**. Systems and Runtime accounted for **313.09 agent-seconds** but their patches were rejected, so about 51% of builder compute did not reach the product tree. The final agent then spent about 283 seconds rebuilding the missing areas.

HoneyBee could not register the fresh comparison project: two `addProject` attempts each waited roughly 125 seconds and failed with `workspace-storage.install-failed` after the storage installer requested elevation. The run reused an already valid profile as a staging path, and the original staged project was restored afterward. This roughly **4m 10s** setup defect is not included in the precise table because the failed attempts did not produce timestamped run artifacts. Including it approximately would put HoneyBee near **14m 58s**, still below the direct cap, but the clean-project workflow was not successful.

## Objective acceptance gates

| Condition           | Compile | ≥30 EditMode tests | Win64 build | Normal ready / no managed exception | Autoplay markers / ≤15s timing | Objective verdict                        |
| ------------------- | ------: | -----------------: | ----------: | ----------------------------------: | -----------------------------: | ---------------------------------------- |
| Controlled multi    |    FAIL |            blocked |        FAIL |                             blocked |                        blocked | Hard fail                                |
| Controlled single   |    pass |              41/41 |        pass |                                pass |              pass / unverified | Gates 1-4 pass; gate 5 unverified        |
| End-to-end HoneyBee |    pass |              39/39 |        pass |                                pass |              pass / unverified | Gates 1-4 pass; gate 5 unverified        |
| End-to-end direct   |    pass |            **0/0** |        pass |                                pass |              pass / unverified | Hard fail: test floor; gate 5 unverified |

All three runnable Players emitted Ready, five phase markers, Complete, and Reset in the required order, with zero detected managed exceptions. `raw/runtime-summary.json` records `resetAtMs: null` and roughly 25-second harness wall times because Unity buffered the Player log until process close. Marker presence and ordering are valid; completion/reset within 15 seconds is unverified, so no runnable result passes gate 5 on the preserved evidence.

Controlled multi failed with:

- two `double` → `float` contract errors in `Presentation/WorldFactory.cs`;
- one `float` → `int` contract error in `Runtime/TutorialGame.cs`.

No agent or harness source correction was made after the failure.

## Quality: what the harness can and cannot decide

The objective harness says that controlled single and end-to-end HoneyBee satisfy gates 1-4, while gate 5 remains unverified for both. Direct produced a visually reviewable, buildable Player at the forced cap, but its missing tests and README are real incompleteness, not a cosmetic penalty; its gate 5 timing is also unverified. Controlled multi is not reviewable as a Player because it does not compile. None of the four artifacts is fully gate-valid on the preserved evidence.

The 25-point visual/“MMORPG feel” portion is intentionally not converted into an unblinded model score. Compare the sealed full-resolution captures in [`blind/A.png`](blind/A.png) and [`blind/B.png`](blind/B.png), then record the preferred image and the five rubric fields in [`blind/BALLOT.md`](blind/BALLOT.md). Open [`blind/SEALED_MAP.json`](blind/SEALED_MAP.json) only after choosing.

This separation addresses the earlier quality confound: tests, compilation, runtime contracts and documentation are harness territory; composition, hierarchy, atmosphere and perceived polish are a blind human judgment.

## Resource and storage measurements

| Condition           |     Peak app WS | Peak provider/process-tree WS | Non-additive upper envelope | Peak generation disk delta |   Final project |      Assets |   Win64 build | Peak Player WS |
| ------------------- | --------------: | ----------------------------: | --------------------------: | -------------------------: | --------------: | ----------: | ------------: | -------------: |
| Controlled multi    | 2,052,485,120 B |               2,036,023,296 B |             4,088,508,416 B |              377,442,304 B | 1,853,389,193 B | 2,628,050 B |          none |           none |
| Controlled single   | 1,601,355,776 B |               1,163,526,144 B |             2,764,881,920 B |               69,414,912 B | 2,040,248,424 B | 2,608,585 B | 101,140,626 B |  530,751,488 B |
| End-to-end HoneyBee | 2,112,040,960 B |               2,045,353,984 B |             4,157,394,944 B |              144,187,392 B | 2,040,603,413 B | 2,635,967 B | 101,165,367 B |  618,754,048 B |
| End-to-end direct   |             n/a |               1,399,328,768 B |             1,399,328,768 B |              279,613,440 B | 2,039,835,350 B | 2,673,540 B | 101,175,905 B |  509,964,288 B |

HoneyBee's app and provider peaks were measured independently and may not occur on the same sample; their sum is an upper envelope, not a measured simultaneous total. The direct number is the measured full process tree. On this trial the four-agent HoneyBee phase required roughly three times the direct process-tree memory envelope, while final build sizes differed by less than 36 KB.

Final project size is dominated by Unity Library caches, so generated source is more informative:

| Condition           | Implementation files | C# files | C# bytes | README | Shader |
| ------------------- | -------------------: | -------: | -------: | -----: | -----: |
| Controlled multi    |                   20 |       18 | 51,526 B |    yes |      1 |
| Controlled single   |                   14 |       12 | 31,201 B |    yes |      1 |
| End-to-end HoneyBee |                   18 |       16 | 56,411 B |    yes |      1 |
| End-to-end direct   |                   18 |       17 | 96,147 B | **no** |      1 |

Line count is not used as a quality measure because some agents emitted highly compressed C#.

## Interpretation

1. **Product-level time win:** HoneyBee produced the artifact that later passed compile, tests, build, and ordered-marker checks much earlier than direct in this one large task; full gate 5 acceptance was not established.
2. **No topology-level quality win:** controlled multi was slower than controlled single and failed compilation.
3. **Integration is the bottleneck:** product Apply rejected two non-overlapping ownership patches because the source manifest was global. A final owner hid the failure by reimplementation, wasting 313 agent-seconds.
4. **Memory is the cost:** the four-agent phase traded a much larger memory envelope for wall-clock concurrency.
5. **Quality must remain split:** the harness decides reliability and completeness; the blind ballot decides visual preference.

The next credible experiment should first implement path-aware or dependency-aware patch composition plus a mandatory final compile/test gate, then repeat this paired protocol at least five times with rotated A/B labels. Until then, HoneyBee is justified as a fast orchestration prototype, not as evidence that multi-agent output is intrinsically higher quality.

## Evidence index

- Protocol: [`EXPERIMENT_PROTOCOL.md`](EXPERIMENT_PROTOCOL.md)
- Fixed spec: [`BENCHMARK_SPEC.md`](BENCHMARK_SPEC.md)
- Shared reference: [`common/ashen-crossing-concept.png`](common/ashen-crossing-concept.png)
- Machine-readable metrics: [`raw/metrics.json`](raw/metrics.json)
- Unity test XML and summary evidence: [`raw/`](raw/)
- Original screenshots: [`evidence/`](evidence/)
- Blind ballot: [`blind/BALLOT.md`](blind/BALLOT.md)
