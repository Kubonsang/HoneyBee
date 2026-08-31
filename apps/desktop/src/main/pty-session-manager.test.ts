import { describe, expect, it } from "vitest";

import { DesktopPtySessionManager } from "./pty-session-manager.js";

class FakePty {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  killed = false;
  dataListener?: (data: string) => void;
  exitListener?: (event: { exitCode: number; signal?: number }) => void;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
    return { dispose() {} };
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(columns: number, rows: number) {
    this.sizes.push([columns, rows]);
  }
  kill() {
    this.killed = true;
  }
  pause() {}
  resume() {}
  clear() {}
  get pid() {
    return 1;
  }
  get cols() {
    return 80;
  }
  get rows() {
    return 24;
  }
  get process() {
    return "fake";
  }
  handleFlowControl = false;
}

describe("DesktopPtySessionManager", () => {
  it("streams output by cursor and forwards input and resize", async () => {
    const fake = new FakePty();
    const manager = new DesktopPtySessionManager(async () => ({
      spawn: () => fake as never,
    }));
    const session = await manager.create({
      profileId: "11111111-1111-4111-8111-111111111111",
      kind: "shell",
      label: "PowerShell",
      command: "powershell.exe",
      args: [],
      cwd: "C:\\project",
      columns: 80,
      rows: 24,
    });

    fake.dataListener?.("hello\r\n");
    expect(manager.snapshot(session.sessionId, 0).chunks[0]?.data).toBe("hello\r\n");
    expect(manager.snapshot(session.sessionId, 1).chunks).toHaveLength(0);
    expect(manager.write(session.sessionId, "dir\r")).toBe(true);
    expect(fake.writes).toEqual(["dir\r"]);
    expect(manager.resize(session.sessionId, 120, 40)).toBe(true);
    expect(fake.sizes).toEqual([[120, 40]]);
    fake.exitListener?.({ exitCode: 0 });
    expect(manager.snapshot(session.sessionId, 1).session).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
  });
});
