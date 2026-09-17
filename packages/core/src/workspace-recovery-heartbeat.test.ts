import { describe, expect, it, vi } from "vitest";

const response = vi.hoisted(() => ({ code: "lease-not-active" }));
vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() =>
      callback(
        Error("broker refused"),
        JSON.stringify({
          ok: false,
          error: { code: response.code, message: response.code },
        }),
        "",
      ),
    );
    return { stdin: { end: () => undefined } };
  },
}));
import { WindowsWorkspaceStorage } from "./workspace-storage.js";

describe("automatic recovery heartbeat", () => {
  const tools = {
    clientCommand: process.execPath,
    controlCommand: process.execPath,
    provenance: "managed" as const,
  };
  it("returns inactive only for the explicit inactive response", async () => {
    response.code = "lease-not-active";
    await expect(
      new WindowsWorkspaceStorage().heartbeat(tools, "lease", { inactiveOnly: true }),
    ).resolves.toBeUndefined();
  });
  it.each(["lease-not-found", "lease-not-ready", "access-denied"])(
    "propagates %s instead of authorizing automatic attach",
    async (code) => {
      response.code = code;
      await expect(
        new WindowsWorkspaceStorage().heartbeat(tools, "lease", { inactiveOnly: true }),
      ).rejects.toMatchObject({ upstreamCode: code });
    },
  );
  it("keeps existing manual repair heartbeat semantics", async () => {
    response.code = "lease-not-ready";
    await expect(new WindowsWorkspaceStorage().heartbeat(tools, "lease")).resolves.toBeUndefined();
  });
});
