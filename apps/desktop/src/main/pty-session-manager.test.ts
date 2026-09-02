import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { DesktopPtySessionManager } from "./pty-session-manager.js";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForOutput = async (
  manager: DesktopPtySessionManager,
  sessionId: string,
  predicate: (output: string) => boolean,
  timeoutMilliseconds: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let output: string;
  do {
    output = manager
      .snapshot(sessionId, 0)
      .chunks.map((chunk) => chunk.data)
      .join("");
    if (predicate(output)) return output;
    await delay(50);
  } while (Date.now() < deadline);
  return output;
};

it.runIf(process.platform === "win32")(
  "opens an interactive PowerShell in the selected Workspace",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "honeybee-workbench-pty-"));
    const manager = new DesktopPtySessionManager();
    try {
      const session = manager.create("workspace-test", cwd, 80, 24);
      expect(session).toMatchObject({ workspaceId: "workspace-test", cwd, state: "running" });
      const prompt = await waitForOutput(
        manager,
        session.sessionId,
        (output) => output.includes("PS ") && output.includes(">"),
        10_000,
      );
      expect(prompt).toContain("PS ");
      expect(manager.write(session.sessionId, "Write-Output HONEYBEE_WORKBENCH_PTY_OK\r")).toBe(
        true,
      );
      const output = await waitForOutput(
        manager,
        session.sessionId,
        (value) => value.includes("HONEYBEE_WORKBENCH_PTY_OK"),
        10_000,
      );
      expect(output).toContain("HONEYBEE_WORKBENCH_PTY_OK");
      expect(manager.write(session.sessionId, "exit\r")).toBe(true);
      let state = manager.snapshot(session.sessionId, 0).session.state;
      for (let attempt = 0; attempt < 200 && state !== "exited"; attempt += 1) {
        await delay(50);
        state = manager.snapshot(session.sessionId, 0).session.state;
      }
      expect(state).toBe("exited");
      expect(manager.close(session.sessionId)).toBe(true);
    } finally {
      manager.closeAll();
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  35_000,
);
