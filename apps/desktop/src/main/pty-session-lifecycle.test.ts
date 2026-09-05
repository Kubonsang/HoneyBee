import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  processes: [] as Array<{
    data: (data: string) => void;
    exit: (event: { exitCode: number }) => void;
    kill: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const process = {
      data: (_data: string) => {},
      exit: (_event: { exitCode: number }) => {},
      kill: vi.fn(),
    };
    fake.processes.push(process);
    return {
      onData: (callback: typeof process.data) => {
        process.data = callback;
      },
      onExit: (callback: typeof process.exit) => {
        process.exit = callback;
      },
      kill: process.kill,
      write: vi.fn(),
      resize: vi.fn(),
    };
  }),
}));
import { DesktopPtySessionManager } from "./pty-session-manager.js";
const firstProcess = () => {
  const process = fake.processes[0];
  if (process === undefined) throw new Error("Expected a fake PTY.");
  return process;
};
beforeEach(() => {
  fake.processes.length = 0;
  vi.stubEnv("SystemRoot", "C:\\Windows");
});
it("reuses a project/workspace session including its exit and output, until explicit close", () => {
  const manager = new DesktopPtySessionManager();
  const first = manager.create("p", "w", "C:\\work", 80, 24);
  firstProcess().data("preserved");
  expect(manager.create("p", "w", "C:\\work", 120, 30).sessionId).toBe(first.sessionId);
  firstProcess().exit({ exitCode: 7 });
  expect(manager.create("p", "w", "C:\\work", 80, 24)).toMatchObject({
    state: "exited",
    exitCode: 7,
  });
  expect(manager.snapshot(first.sessionId, 0).chunks[0]?.data).toBe("preserved");
  expect(fake.processes).toHaveLength(1);
  manager.close(first.sessionId);
  expect(manager.create("p", "w", "C:\\work", 80, 24).sessionId).not.toBe(first.sessionId);
  expect(manager.create("other", "w", "C:\\other", 80, 24).projectId).toBe("other");
});
it("blocks removal without mutation, and blocks creation throughout pending removal", async () => {
  const manager = new DesktopPtySessionManager();
  const session = manager.create("p", "w", "C:\\work", 80, 24);
  const remove = vi.fn(async () => true);
  await expect(manager.withWorkspaceRemoval("p", "w", remove)).rejects.toMatchObject({
    code: "desktop.terminal-running",
  });
  expect(remove).not.toHaveBeenCalled();
  expect(firstProcess().kill).not.toHaveBeenCalled();
  manager.close(session.sessionId);
  let finish!: () => void;
  const pending = manager.withWorkspaceRemoval(
    "p",
    "w",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(() => manager.create("p", "w", "C:\\work", 80, 24)).toThrow("removal is in progress");
  await expect(manager.withWorkspaceRemoval("p", "w", remove)).rejects.toMatchObject({
    code: "workspace.in-use",
  });
  finish();
  await pending;
  await expect(
    manager.withWorkspaceRemoval("p", "w", async () => {
      throw new Error("busy");
    }),
  ).rejects.toThrow("busy");
  expect(manager.create("p", "w", "C:\\work", 80, 24).state).toBe("running");
});
it("bounds sessions and buffered output without evicting running shells", () => {
  const manager = new DesktopPtySessionManager();
  const first = manager.create("p", "0", "C:\\work", 80, 24);
  for (let index = 1; index < 16; index++) manager.create("p", String(index), "C:\\work", 80, 24);
  expect(() => manager.create("p", "17", "C:\\work", 80, 24)).toThrow("16-terminal limit");
  expect(manager.create("p", "0", "C:\\work", 80, 24).sessionId).toBe(first.sessionId);
  for (let index = 0; index < 1_001; index++) firstProcess().data("x");
  expect(manager.snapshot(first.sessionId, 0)).toMatchObject({ truncated: true, cursor: 1_001 });
  expect(manager.snapshot(first.sessionId, 0).chunks).toHaveLength(1_000);
  firstProcess().data("x".repeat(2 * 1024 * 1024 + 1));
  expect(manager.snapshot(first.sessionId, 1_001).chunks).toHaveLength(0);
  manager.closeAll();
  expect(manager.list()).toEqual([]);
  expect(fake.processes.every((process) => process.kill.mock.calls.length === 1)).toBe(true);
});

it("keeps all sessions on quit cancellation and closes exactly once on approval", () => {
  const manager = new DesktopPtySessionManager();
  const session = manager.create("p", "w", "C:\\work", 80, 24);
  const cancel = vi.fn(() => false);
  expect(manager.requestQuit(cancel)).toBe(false);
  expect(manager.list()[0]?.sessionId).toBe(session.sessionId);
  expect(firstProcess().kill).not.toHaveBeenCalled();
  const approve = vi.fn(() => true);
  expect(manager.requestQuit(approve)).toBe(true);
  expect(manager.requestQuit(approve)).toBe(true);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(firstProcess().kill).toHaveBeenCalledTimes(1);
  expect(() => manager.create("p", "w", "C:\\work", 80, 24)).toThrow("HoneyBee is closing");
});
