import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { SystemUnityProcessControl } from "./process-control.js";

describe("SystemUnityProcessControl", () => {
  it("drains only the surviving process incarnation that was recorded", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      const pid = child.pid;
      expect(pid).toBeDefined();
      const control = new SystemUnityProcessControl();
      const identity = await control.captureIdentity(pid as number);
      expect(identity).toBeTruthy();

      await control.drain(pid as number, identity);
      await closed;

      expect(() => process.kill(pid as number, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);

  it("does not terminate a live PID whose incarnation differs", async () => {
    const control = new SystemUnityProcessControl();
    await expect(
      control.drain(process.pid, "not-the-current-incarnation"),
    ).resolves.toBeUndefined();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
