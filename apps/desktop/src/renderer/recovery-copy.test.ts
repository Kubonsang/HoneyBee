import { expect, it } from "vitest";
import { recoveryElapsed, recoveryReason, recoveryStateLabels } from "./recovery-copy.js";

it("keeps uncertain outcomes distinct from successful recovery in both languages", () => {
  for (const locale of ["ko", "en"] as const) {
    expect(recoveryStateLabels[locale].Unresolved).not.toBe(recoveryStateLabels[locale].Succeeded);
    expect(recoveryReason("recovery.setup-incomplete", locale)).toBeTruthy();
    expect(recoveryReason("untrusted-path", locale)).toBeUndefined();
  }
});
it("elapsed time handles missing and future timestamps without inventing progress", () => {
  const now = Date.parse("2026-11-08T00:01:00Z");
  expect(recoveryElapsed("2026-11-08T00:00:00Z", now)).toBe(60);
  expect(recoveryElapsed("2026-11-08T00:02:00Z", now)).toBe(0);
  expect(recoveryElapsed(null, now)).toBeNull();
  expect(recoveryElapsed("invalid", now)).toBeNull();
});
