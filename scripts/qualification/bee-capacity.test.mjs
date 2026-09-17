import assert from "node:assert/strict";
import test from "node:test";
import { requiredChildReservation } from "./bee-capacity.mjs";
test("Bee allocation rounds up by the native child reservation quantum", () => {
  const unit = 2 * 1024 ** 3;
  assert.equal(requiredChildReservation(unit), unit);
  assert.equal(requiredChildReservation(unit, { allocatedBytes: 64 }), 2 * unit);
  assert.equal(requiredChildReservation(unit, { allocatedBytes: unit }), 2 * unit);
  assert.equal(requiredChildReservation(unit, { allocatedBytes: unit + 1 }), 3 * unit);
});
test("invalid allocation cannot authorize a retry", () => {
  for (const allocatedBytes of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(() => requiredChildReservation(2 * 1024 ** 3, { allocatedBytes }));
});
