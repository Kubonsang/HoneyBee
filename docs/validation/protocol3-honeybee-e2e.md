# Protocol 3 HoneyBee E2E validation

## Result

The real Windows HoneyBee v0.6 transaction passed on 2026-08-19.

```text
verdict: HONEYBEE_PROTOCOL3_E2E_PASS
cleanup: released
```

This validation covers one owned Unity Editor, one isolated workspace, and the
ordered `compile` then `warm-test` capability sequence. It does not claim
general production readiness.

## Pinned inputs

- HoneyBee commit:
  `2ce6087b9a81f33b604efcaaedc836347399ad66`
- HoneyBee runtime tree SHA-256:
  `23AC5FF5B6C5F2EDBA2DA91868A9FAEB32CF0F754572E528BFFD9B8344143F7C`
- TestPlay feature branch evidence commit:
  `5ce4889e11d8420cd6b33030e7bb8eeea14d12e6`
- TestPlay executable commit:
  `ef92a736a4743c22e9e5d956454db14e9d491bb1`
- TestPlay executable SHA-256:
  `7A25823E75FF458D2353A371091F6982347BD928196CFB2E6D6406F05CE1A2FC`
- TestPlay bridge package tree SHA-256:
  `4746D75CBC485421C0C3F3EC580376CB5BB6888C6FC0BC4E0CD17ED02B0CF753`
- workspace-storage contract commit:
  `575c3b37896cd3dfa37a4705477837cc52ec6132`
- workspace-storage executable SHA-256:
  `630F6778FC305ADF993AF1FF073F0D8F3C3131F7050BC124EF31F0F691A8C2CF`

## Verified behavior

- HoneyBee acquired one broker-owned differencing workspace and launched one
  owned headless Unity Editor.
- Protocol 3 bound the same exact workspace ID, Editor PID, and bridge session
  for both capabilities.
- `compile` completed with zero compile errors and executed no tests.
- `warm-test` completed through the bridge with `1/1` passing and no fallback.
- HoneyBee stored the bounded TestPlay evidence in its content-addressed
  artifact store before release.
- Source `Assets`, `Packages`, `ProjectSettings`, and `packages-lock.json` were
  unchanged.
- The immutable parent VHDX SHA-256 was unchanged.
- Workspace release completed, the temporary TestPlay broker was removed, and
  the prior broker identity was restored.
- Active, retained, pending, and quarantined child counts were zero; new
  file-backed disk and related-process residuals were zero.

## Artifact

```text
C:\Users\user\AppData\Local\Temp\testplay-honeybee-protocol3-e2e-20260819-121300-676.zip
SHA-256: 7C46F8F0E9EAB73EFF7F143D6F5799B428D82BE62D3F0C122CC566CAC590C2E4
```

Forced-termination recovery, broader hardware coverage, and production
readiness remain separate gates.
