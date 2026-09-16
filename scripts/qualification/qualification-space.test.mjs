import assert from "node:assert/strict";
import test from "node:test";
import { requireQualificationSpace } from "./integrated-flow.mjs";
const admitted = {
  phase: "preflight",
  state: "Completed",
  result: { guest: { freeBytes: 16 * 1024 ** 3 } },
};
test("initial allowance is not charged again after preparation on admitted resume", () => {
  requireQualificationSpace(16 * 1024 ** 3);
  assert.throws(() => requireQualificationSpace(15 * 1024 ** 3));
  requireQualificationSpace(15 * 1024 ** 3, admitted);
});
test("resume retains evidence headroom and requires successful original capacity admission", () => {
  assert.throws(() => requireQualificationSpace(63 * 1024 ** 2, admitted));
  for (const free of [NaN, -1, undefined])
    assert.throws(() => requireQualificationSpace(free, admitted));
  assert.throws(() => requireQualificationSpace(15 * 1024 ** 3, { ...admitted, state: "Started" }));
  assert.throws(() =>
    requireQualificationSpace(15 * 1024 ** 3, { ...admitted, result: { guest: { freeBytes: 1 } } }),
  );
});
