import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { productVersionFiles, synchronizeProductVersion } from "./product-version.mjs";
import { synchronizeRecoverySupport } from "./recovery-support.mjs";

test("product version generation preserves component versions, hashes and package dependencies", () => {
  const compatibility = {
    honeybeeVersion: "old",
    workspaceStorage: [
      { honeybeeVersion: "old", version: "hb17", payloads: [{ sha256: "pinned" }] },
    ],
    testplay: [],
  };
  const input = JSON.parse(JSON.stringify(compatibility));
  const files = productVersionFiles(
    { version: "0.1.0-beta.40" },
    Array.from({ length: 3 }, () => ({ version: "old", dependencies: { zod: "4" } })),
    input,
  );
  const next = JSON.parse(files.get("apps/desktop/resources/component-compatibility-v1.json"));
  assert.equal(next.honeybeeVersion, "0.1.0-beta.40");
  assert.equal(next.workspaceStorage[0].version, "hb17");
  assert.deepEqual(next.workspaceStorage[0].payloads, compatibility.workspaceStorage[0].payloads);
  assert.deepEqual(input, compatibility);
  assert.deepEqual(JSON.parse(files.get("apps/cli/package.json")).dependencies, { zod: "4" });
});

test("unsafe or absent product versions cannot become directory names or source", () => {
  for (const version of [undefined, "../test", "1.0.0\n", '1.0.0";', "beta.40"]) {
    assert.throws(() => productVersionFiles({ version }, [{}, {}, {}], {}));
  }
});

test("checked-in build versions match the root product version", async () => {
  await synchronizeProductVersion(fileURLToPath(new URL("../../", import.meta.url)), {
    check: true,
  });
});

test("the recovery guide and UI share the support table", async () => {
  await synchronizeRecoverySupport(fileURLToPath(new URL("../../", import.meta.url)), {
    check: true,
  });
});
