import { expect, it } from "vitest";
import { storageRecoveryState } from "./storage-recovery.js";
import {
  DesktopStorageRecoveryActionV1Schema,
  DesktopStorageRecoveryV1Schema,
} from "../shared/ipc.js";

it("shows a version mismatch separately from a valid receipt", () => {
  expect(
    storageRecoveryState([
      { code: "storage.install-receipt", status: "pass" },
      { code: "storage.component-version", status: "fail" },
    ]),
  ).toBe("version");
});
it("prioritizes owner/integrity failures and never treats missing diagnostics as ready", () => {
  expect(
    storageRecoveryState([
      { code: "storage.install-receipt", status: "fail" },
      { code: "storage.component-version", status: "fail" },
    ]),
  ).toBe("identity");
  expect(storageRecoveryState([])).toBe("attention");
  expect(storageRecoveryState([{ code: "storage.package-integrity", status: "warning" }])).toBe(
    "attention",
  );
  expect(storageRecoveryState([{ code: "storage.service", status: "fail" }])).toBe("service");
});
it("accepts only fixed recovery resources, never a URL, command or executable", () => {
  expect(DesktopStorageRecoveryActionV1Schema.parse({ action: "download-setup" })).toEqual({
    action: "download-setup",
  });
  for (const request of [
    { action: "replace" },
    { action: "install" },
    { action: "download-setup", url: "https://example.com/setup.exe" },
    { action: "open-guide", path: "C:/other.exe" },
  ])
    expect(() => DesktopStorageRecoveryActionV1Schema.parse(request)).toThrow();
});
it("preserves structured component versions through the strict preload response schema", () => {
  const report = DesktopStorageRecoveryV1Schema.parse({
    schemaVersion: 1,
    applicationVersion: "0.1.0-beta.38",
    installation: "managed",
    doctor: {
      schemaVersion: 1,
      ready: false,
      summary: { pass: 1, warning: 0, fail: 1 },
      checks: [
        {
          code: "storage.component-version",
          status: "fail",
          message: "mismatch",
          actualVersion: "hb12",
          expectedVersion: "hb16",
        },
      ],
    },
  });
  expect(report.doctor.checks[0]?.actualVersion).toBe("hb12");
});

it("does not offer ordinary updates as a fix for the unsupported legacy hb12 source", () => {
  expect(
    storageRecoveryState([
      { code: "storage.install-receipt", status: "pass" },
      {
        code: "storage.component-version",
        status: "fail",
        actualVersion: "0.0.0+cfa606fd4143.hb12",
      },
    ]),
  ).toBe("legacy");
});
