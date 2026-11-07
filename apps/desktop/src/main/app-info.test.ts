import { describe, expect, it } from "vitest";
import { appInfo } from "./app-info.js";

describe("application identity", () => {
  it("shows the validated running release, not stale build metadata or a newer pointer", () => {
    expect(
      appInfo({
        packaged: true,
        buildVersion: "0.1.0-beta.11",
        releaseRoot: "installation/versions/0.1.0-beta.39",
        managed: true,
        checks: [],
      }),
    ).toMatchObject({
      applicationVersion: "0.1.0-beta.39",
      installedStorageVersion: null,
      installation: "managed",
    });
  });
  it("distinguishes development and portable builds from managed installations", () => {
    const input = {
      buildVersion: "0.1.0-beta.40",
      releaseRoot: "untrusted",
      managed: false,
      checks: [],
    };
    expect(appInfo({ ...input, packaged: false }).installation).toBe("development");
    expect(appInfo({ ...input, packaged: true }).installation).toBe("portable");
  });
});
