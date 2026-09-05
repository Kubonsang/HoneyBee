import { expect, it } from "vitest";
import { setupBlockers } from "./setup-checks.js";
import { setupGuidance } from "../renderer/setup-guidance.js";
import { message } from "../renderer/i18n.js";

it("uses the same blocking prerequisites for setup and keeps unrelated projects independent", () => {
  const checks = [
    "storage.service",
    "system.windows",
    "runtime.node",
    "git.executable",
    "registry.read",
    "project.storage-tools",
  ].map((code) => ({ code, status: "fail" }));
  expect(setupBlockers(checks).map((item) => item.code)).toEqual(
    checks.slice(0, 5).map((item) => item.code),
  );
  expect(setupBlockers([{ code: "storage.package-integrity", status: "warning" }])).toEqual([]);
  expect(setupBlockers(checks.map((item) => ({ ...item, status: "pass" })))).toEqual([]);
});

it("gives distinct bilingual installation, version, receipt, and permission guidance", () => {
  const codes = [
    "storage.service",
    "storage.component-version",
    "storage.install-receipt",
    "storage.workspace-root",
  ];
  for (const locale of ["ko", "en"] as const) {
    expect(new Set(codes.map((code) => message(locale, setupGuidance(code)))).size).toBe(4);
  }
});
