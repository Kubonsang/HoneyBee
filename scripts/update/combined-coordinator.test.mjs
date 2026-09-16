import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";
import { resolveCombinedCoordinator } from "./installed-combined-update.mjs";

const context = () => {
  const source = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      activeVersion: "0.1.0-beta.11",
      manifestSha256: "a".repeat(64),
    }),
  );
  const target = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generation: 2,
      activeVersion: "0.1.0-beta.15",
      manifestSha256: "b".repeat(64),
    }),
  );
  const identity = {
    manifestSha256: "c".repeat(64),
    sourcePointerSha256: sha256(source),
    serviceTransactionSha256: "d".repeat(64),
  };
  return {
    schemaVersion: 1,
    identity,
    identitySha256: combinedUpdateIdentity(identity),
    sourcePointer: source.toString("base64"),
    targetPointer: target.toString("base64"),
    launcherSha256: "e".repeat(64),
  };
};
test("legacy contexts retain the authenticated source coordinator", async () => {
  const root = path.resolve("fixture"),
    seen = [];
  const executable = await resolveCombinedCoordinator(root, context(), async (p) => seen.push(p));
  assert.deepEqual(seen, [path.join(root, "versions/0.1.0-beta.11")]);
  assert.equal(executable, path.join(seen[0], "tools/honeybee-workspace-storage-host.exe"));
});
test("durable target selection reauthenticates after reconstruction", async () => {
  const value = JSON.parse(JSON.stringify({ ...context(), nativeCoordinator: "target" }));
  const root = path.resolve("fixture"),
    seen = [];
  const exe = await resolveCombinedCoordinator(root, value, async (p) => seen.push(p));
  assert.equal(
    exe,
    path.join(root, "versions/0.1.0-beta.15/tools/honeybee-workspace-storage-host.exe"),
  );
  assert.equal(seen.length, 1);
  await assert.rejects(
    resolveCombinedCoordinator(root, value, async () => {
      throw Error("tampered signed payload");
    }),
    /tampered/,
  );
});
test("arbitrary coordinator paths and unknown modes fail before execution", async () => {
  for (const nativeCoordinator of ["source", "C:\\arbitrary.exe", "../target", true])
    await assert.rejects(
      resolveCombinedCoordinator(
        path.resolve("fixture"),
        { ...context(), nativeCoordinator },
        async () => {
          assert.fail("must not authorize invalid context");
        },
      ),
      /Unsupported native coordinator/,
    );
});
