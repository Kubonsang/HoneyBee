import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { authorizeLegacySetupSource, legacySetupSource } from "./legacy-setup-source.mjs";

async function fixture() {
  const parent = path.resolve("output/legacy-setup-source-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const pointer = {
    schemaVersion: 1,
    generation: 1,
    activeVersion: legacySetupSource.version,
    manifestSha256: legacySetupSource.launchManifestSha256,
  };
  const pointerBytes = JSON.stringify(pointer);
  await writeFile(path.join(root, "current.json"), pointerBytes);
  return { root, pointer, pointerBytes };
}

for (const scenario of ["selected-target", "unknown-pointer"]) {
  test(`external Setup can authenticate the original source during recovery: ${scenario}`, async () => {
    const f = await fixture();
    const sourcePointerBytes = Buffer.from(f.pointerBytes);
    const targetPointerBytes = Buffer.from(
      JSON.stringify({
        ...f.pointer,
        generation: 2,
        activeVersion: "0.1.0-beta.38",
        manifestSha256: "a".repeat(64),
      }),
    );
    const current =
      scenario === "selected-target"
        ? targetPointerBytes
        : Buffer.from(JSON.stringify({ ...f.pointer, generation: 7 }));
    await writeFile(path.join(f.root, "current.json"), current);
    let calls = 0;
    const operation = authorizeLegacySetupSource(f.root, {
      sourcePointerBytes,
      targetPointerBytes,
      digest: async (file) =>
        legacySetupSource.infrastructure[path.relative(f.root, file).split(path.sep).join("/")],
      run: async () => {
        calls++;
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            recoveryManifestSha256: legacySetupSource.infrastructure["recovery/v1/manifest.json"],
          }),
        };
      },
      authorizeSource: async (root, runtime, pointer) => {
        assert.equal(pointer.activeVersion, legacySetupSource.version);
        return true;
      },
    });
    if (scenario === "selected-target") {
      const result = await operation;
      assert.deepEqual(result.pointerBytes, sourcePointerBytes);
      assert.deepEqual(result.currentPointerBytes, targetPointerBytes);
      assert.equal(calls, 1);
    } else {
      await assert.rejects(operation, /Unknown pointer/u);
      assert.equal(calls, 0);
    }
    assert.deepEqual(await readFile(path.join(f.root, "current.json")), current);
  });
}

for (const scenario of [
  "valid",
  "infrastructure",
  "runtime",
  "source",
  "pointer-drift",
  "infrastructure-drift",
  "other-version",
  "other-launch",
]) {
  test(`external legacy Setup source authorization: ${scenario}`, async () => {
    const f = await fixture();
    let executions = 0,
      authorizations = 0;
    if (scenario === "other-version")
      await writeFile(
        path.join(f.root, "current.json"),
        JSON.stringify({ ...f.pointer, activeVersion: "0.1.0-beta.36" }),
      );
    if (scenario === "other-launch")
      await writeFile(
        path.join(f.root, "current.json"),
        JSON.stringify({ ...f.pointer, manifestSha256: "a".repeat(64) }),
      );
    const operation = authorizeLegacySetupSource(f.root, {
      digest: async (file) => {
        const name = path.relative(f.root, file).split(path.sep).join("/");
        assert(Object.hasOwn(legacySetupSource.infrastructure, name));
        if (
          scenario === "infrastructure" ||
          (scenario === "infrastructure-drift" && authorizations)
        )
          return "a".repeat(64);
        return legacySetupSource.infrastructure[name];
      },
      run: async (executable, args, options) => {
        executions++;
        assert.equal(executable, path.join(f.root, "HoneyBeeLauncher.exe"));
        assert.deepEqual(args, ["--verify-recovery-runtime"]);
        assert.equal(options.windowsHide, true);
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            recoveryManifestSha256:
              scenario === "runtime"
                ? "a".repeat(64)
                : legacySetupSource.infrastructure["recovery/v1/manifest.json"],
          }),
        };
      },
      authorizeSource: async (root, runtime, pointer) => {
        authorizations++;
        assert.equal(root, f.root);
        assert.equal(runtime, path.join(f.root, "recovery/v1"));
        assert.deepEqual(pointer, f.pointer);
        if (scenario === "pointer-drift")
          await writeFile(
            path.join(f.root, "current.json"),
            JSON.stringify({ ...f.pointer, generation: 2 }),
          );
        return scenario !== "source";
      },
    });
    if (scenario === "valid") {
      const result = await operation;
      assert.equal(result.launcherSha256, legacySetupSource.infrastructure["HoneyBeeLauncher.exe"]);
      assert.equal(result.pointerBytes.toString(), f.pointerBytes);
      assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointerBytes);
      assert.equal(executions, 1);
      assert.equal(authorizations, 1);
    } else await assert.rejects(operation);
    if (["infrastructure", "other-version", "other-launch"].includes(scenario))
      assert.equal(executions, 0);
    if (["infrastructure", "runtime", "other-version", "other-launch"].includes(scenario))
      assert.equal(authorizations, 0);
  });
}
