import { afterEach, expect, it, vi } from "vitest";
import { DesktopApiError } from "../shared/ipc.js";
import { decodeDesktopError, desktopApi } from "./desktop-api.js";

afterEach(() => vi.unstubAllGlobals());
it("restores typed errors after Electron copies only their message", async () => {
  const transport = new Error(
    JSON.stringify({
      honeybeeError: { code: "workspace.in-use", message: "busy", remediation: ["Close Unity."] },
    }),
  );
  vi.stubGlobal("window", {
    honeybee: Object.freeze({ projects: () => Promise.reject(transport) }),
  });
  await expect(desktopApi.projects()).rejects.toBeInstanceOf(DesktopApiError);
  await expect(desktopApi.projects()).rejects.toMatchObject({
    code: "workspace.in-use",
    message: "busy",
    remediation: ["Close Unity."],
  });
  const ordinary = new Error("plain failure");
  expect(decodeDesktopError(ordinary)).toBe(ordinary);
  const invalid = new Error('{"honeybeeError":{"code":"incomplete"}}');
  expect(decodeDesktopError(invalid)).toBe(invalid);
});
