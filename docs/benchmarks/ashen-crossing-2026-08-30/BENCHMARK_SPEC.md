# Ashen Crossing — MMORPG tutorial vertical slice

## Goal and constraints

Build a polished, scene-independent Unity 6 URP tutorial slice in the existing blank project. Create
the entire playable world at runtime from C# and Unity primitives. Do not hand-edit `.unity`,
`.prefab`, `.asset`, package, or project-settings YAML. Do not add external packages or download
assets. Do not create asmdefs.

All implementation files must live under `Assets/AshenCrossing/**`, use namespace root
`AshenCrossing`, and remain compatible with the old and new Unity input paths. Do not modify
`Assets/AshenCrossing/BENCHMARK_SPEC.md` or `Assets/AshenCrossing/Reference/**`.

The exact shared visual reference is `Assets/AshenCrossing/Reference/ashen-crossing-concept.png`,
SHA-256 `962c878975e014fbbaab358d5bf63ce0e33ae4be351f185acc9df6448194ab46`.
Use it for composition, landmark hierarchy, and palette. It is inspiration, not a requirement for
custom meshes or textures.

## Player-visible flow

1. Spawn inside Emberwatch Outpost with a clearly marked NPC, Warden Ilya.
2. Approach Ilya and press E to accept `Ashen Crossing`.
3. Repair/activate three cyan signal beacons along the canyon route by holding or pressing E.
4. Defeat five ash invaders with Space basic attacks and Q ember sweep.
5. The bridge gate opens only after all three beacons and five invaders are complete.
6. Cross the bridge and defeat the Ash Colossus. Below 50% health it visibly enters phase two,
   changes color/tempo, and uses a telegraphed area eruption.
7. Return to Ilya and press E. Award exactly 300 XP, level 2, and 90 gold.
8. R resets the full slice. Left Shift dodges. Key 1 consumes one of two health potions.

Required controls: WASD move, E interact, Space basic attack, Q sweep, Left Shift dodge, 1 potion,
R reset.

## Presentation bar

- A readable outpost, three-route beacon sites, five invader silhouettes, a gated bridge, and a
  circular Colossus arena built from primitives.
- Elevated three-quarter follow camera with a clear outpost-to-arena route.
- Strong charcoal/rust/ember palette with cyan objective accents and an obvious phase-two boss color.
- Runtime uGUI that remains readable at 1280x720:
  player health/mana, level/XP/gold/potions, quest title and stage checklist, contextual prompt,
  basic/sweep/dodge cooldowns, controls legend, feedback toasts, bridge status, and boss panel.
- No overlapping or clipped primary labels. Objective state changes must be visible without reading
  the Player log.
- Use a Shader asset under `Resources`; do not rely only on `Shader.Find` for player inclusion.
- The normal Player must look like an MMORPG tutorial, not a debug test scene.

## Public systems contract

Systems builder owns:

- `Assets/AshenCrossing/Systems/**`
- `Assets/AshenCrossing/Tests/Editor/Systems/**`

Namespace `AshenCrossing.Systems`:

- `enum TutorialPhase { MeetWarden, ActivateBeacons, DefeatInvaders, CrossBridge, DefeatColossus, ReturnToOutpost, Completed }`
- `sealed class TutorialProgress`
  - constants `RequiredBeacons = 3`, `RequiredInvaders = 5`
  - read-only properties `Phase`, `Beacons`, `Invaders`, `BridgeCrossed`, `BossDefeated`,
    `Experience`, `Level`, `Gold`
  - `AcceptQuest`, `RecordBeacon`, `RecordInvader`, `RecordBridgeCrossed`,
    `RecordBossDefeated`, `CompleteQuest` return bool
  - strict ordered transitions; out-of-order and extra calls return false and do not over-count
  - completion awards 300 XP, level 2, 90 gold exactly once
  - `Reset()` restores initial state
- `sealed class PlayerResources`
  - max health 140, max mana 100, two potions
  - clamped damage/heal/mana spend/restore/potion use/reset
  - normalized health and mana
- `sealed class AbilityCooldownModel`
  - pure C# primary/sweep/dodge cooldown state, tick, readiness, consume, reset
- At least 16 focused EditMode NUnit tests across progression, resources, and cooldowns.

Systems code must not reference Presentation or Runtime.

## Public presentation contract

Presentation builder owns:

- `Assets/AshenCrossing/Presentation/**`
- `Assets/AshenCrossing/Resources/**`
- `Assets/AshenCrossing/Tests/Editor/Presentation/**`

Namespace `AshenCrossing.Presentation`:

- `sealed class WorldReferences`
  - `Transform Root`, `GameObject Player`, `GameObject Warden`, `GameObject Boss`,
    `GameObject BridgeGate`
  - `List<GameObject> Beacons`, `List<GameObject> Invaders`
  - `Vector3 PlayerSpawn`, `Vector3 BossSpawn`, `Vector3 ReturnPoint`
- `static class WorldFactory` with `WorldReferences Build()`
- `sealed class TutorialViewModel` with settable objective title/detail, prompt, normalized
  health/mana, health/mana labels, level/XP/gold/potions, three cooldown values, beacon/invader
  counts, bridge status, boss visible/name/health/phase, toast, and completion state.
- `sealed class TutorialHud : MonoBehaviour`
  - `Build()`, `Render(TutorialViewModel)`, `Flash(string, Color, float seconds = 2f)`
- `sealed class TutorialCameraRig : MonoBehaviour`
  - `Configure(Transform target)` and follows using an elevated three-quarter composition
- `WorldFactory` loads its surface shader with `Resources.Load<Shader>` and throws a clear exception
  if absent.
- At least 5 EditMode tests for deterministic view-model formatting/validation helpers.

Presentation code must not reference Systems or Runtime.

## Public runtime/combat contract

Runtime builder owns:

- `Assets/AshenCrossing/Runtime/**`
- `Assets/AshenCrossing/Tests/Editor/Runtime/**`
- `Assets/AshenCrossing/README.md`

Namespace `AshenCrossing.Runtime`:

- `AshenCrossingBootstrap` uses
  `RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)` and creates exactly one
  controller.
- `TutorialGame : MonoBehaviour` calls `WorldFactory.Build`, attaches/configures player, invader,
  boss, camera and HUD components, drives the exact systems state machine, proximity interaction,
  bridge gating, reward, feedback, defeat recovery, and R reset.
- Runtime combat components implement player movement/facing, primary and sweep attacks, dodge,
  invader chase/melee, and Colossus chase/melee/telegraphed eruption. The Colossus must visibly
  switch phase below 50%.
- Input must compile when the Input System is enabled and include a safe legacy fallback.
- Log `ASHEN_CROSSING_READY beacons=3 invaders=5 boss=1` only after world, HUD, camera, and gameplay
  initialize successfully.
- Runtime errors must not be swallowed. A ready marker before successful initialization is invalid.
- `BenchmarkAutoplay` activates only when the command line contains `--benchmark-autoplay`. It must
  drive public gameplay/state methods, complete within 15 seconds, then reset, and log exactly:
  - `ASHEN_AUTOPLAY phase=ActivateBeacons`
  - `ASHEN_AUTOPLAY phase=DefeatInvaders`
  - `ASHEN_AUTOPLAY phase=CrossBridge`
  - `ASHEN_AUTOPLAY phase=DefeatColossus`
  - `ASHEN_AUTOPLAY phase=ReturnToOutpost`
  - `ASHEN_CROSSING_COMPLETE level=2 xp=300 gold=90`
  - `ASHEN_CROSSING_RESET phase=MeetWarden`
- At least 5 EditMode integration/contract tests that do not require PlayMode.
- README documents controls, flow, architecture, tests, Windows build, and autoplay verification.

The runtime builder may reference the Systems and Presentation public contracts but may not edit
their ownership areas during the builder phase.

## Final-owner remit

After the three builder outputs are integrated, the fourth HoneyBee agent becomes the sole final
owner and may edit any implementation or test under `Assets/AshenCrossing/**` except the spec and
reference. It must:

- inspect all merged source and the concept image
- resolve contract/compile issues
- run static review and improve weak composition, HUD hierarchy, feedback, and gameplay feel
- preserve the exact progression and autoplay markers
- add/fix tests where useful
- leave a coherent, maintainable, buildable vertical slice

This pass is evaluated for visual and UX quality, not merely conflict resolution.

## Acceptance gates

1. Unity compiles with zero C# errors.
2. At least 30 EditMode tests pass.
3. StandaloneWindows64 build succeeds.
4. Normal 1280x720 Player reaches the exact ready marker without a managed exception.
5. Autoplay emits every exact marker above in order, completes and resets within 15 seconds, with no
   managed exception.
6. The visible screenshot contains a readable route, three cyan beacon landmarks, bridge gate,
   outpost, arena/Colossus, objective HUD, player vitals, abilities, and controls.

## Automatic quality rubric (100)

- Function and progression (30)
  - exact state machine/reward/reset 12
  - interactive movement/combat/beacons/bridge/boss 12
  - autoplay contract 6
- Visual clarity and MMORPG tutorial feel (25)
  - world composition/landmark route 10
  - palette/lighting/silhouettes/boss phase 7
  - HUD hierarchy at 1280x720 8
- UX and onboarding feedback (15)
  - objective/checklist/prompt 6
  - cooldown/combat/bridge/boss feedback 5
  - completion/reset/recovery 4
- Architecture and maintainability (10)
- Tests and runtime reliability (15)
- Documentation (5)

Build failure, missing ready/autoplay/reset marker, managed runtime exception, or fewer than 30
passing tests is a hard failure until corrected.
