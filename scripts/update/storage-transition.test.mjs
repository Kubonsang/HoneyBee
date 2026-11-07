import assert from "node:assert/strict";
import test from "node:test";
import { assertMatchingStorageIdentity } from "./storage-transition.mjs";

const installed = {
  schemaVersion: 1,
  componentVersion: "test.hb17",
  clientSha256: "a".repeat(64),
  controlSha256: "b".repeat(64),
};
test("matching storage can be retained across application versions", () => {
  assert.doesNotThrow(() =>
    assertMatchingStorageIdentity(
      { ...installed, version: "0.1.0-beta.38" },
      { ...installed, version: "0.1.0-beta.39" },
    ),
  );
});
test("same storage identifier cannot conceal changed client or broker bytes", () => {
  for (const key of ["clientSha256", "controlSha256"]) {
    assert.throws(
      () => assertMatchingStorageIdentity(installed, { ...installed, [key]: "c".repeat(64) }),
      /Changed storage payload/,
    );
  }
  assert.throws(
    () => assertMatchingStorageIdentity({ ...installed, clientSha256: undefined }, installed),
    /Invalid source storage digest/,
  );
  assert.throws(
    () => assertMatchingStorageIdentity(installed, { ...installed, componentVersion: "test.hb18" }),
    /Storage version differs/,
  );
});
