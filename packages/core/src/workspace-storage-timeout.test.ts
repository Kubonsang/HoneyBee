import { afterEach, beforeEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import { WindowsWorkspaceStorage } from "./workspace-storage.js";
type Completion = (error: Error | null, stdout: string, stderr: string) => void;
let finish: Completion, signal: AbortSignal, requestId: string;
let sequence: number,
  advancing: boolean,
  disconnected: boolean,
  restarted: boolean,
  unsupported: boolean;
let completed: Record<string, unknown> | undefined;
const success = JSON.stringify({ ok: true, parent: { parentId: "parent", allocatedBytes: 123 } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("HONEYBEE_PARENT_COMMIT_TIMEOUT_MS", undefined);
  vi.stubEnv("HONEYBEE_PARENT_COMMIT_IDLE_TIMEOUT_MS", undefined);
  sequence = 1;
  advancing = true;
  disconnected = false;
  restarted = false;
  unsupported = false;
  completed = undefined;
  execute.mockImplementation(
    (_file: string, args: string[], options: { signal: AbortSignal }, callback: Completion) => {
      options.signal.addEventListener(
        "abort",
        () => callback(new Error("client aborted"), "", ""),
        { once: true },
      );
      if (args[0] === "control")
        return {
          stdin: {
            end: (input: string) => {
              const q = JSON.parse(input) as Record<string, unknown>;
              if (unsupported) {
                callback(
                  null,
                  JSON.stringify({ ok: false, error: { code: "unknown-operation" } }),
                  "",
                );
                return;
              }
              const target = q.targetRequestId !== undefined;
              if (target && disconnected) {
                callback(new Error("pipe unavailable"), "", "");
                return;
              }
              callback(
                null,
                JSON.stringify({
                  ok: true,
                  requestId: q.requestId,
                  commitObservation: {
                    version: 1,
                    brokerSessionId: restarted ? "restarted" : "session",
                    requestId: target ? q.targetRequestId : "",
                    transactionId: target ? q.transactionId : "",
                    state: target ? (completed === undefined ? "running" : "completed") : "capable",
                    phase: "bee-copy",
                    sequence: advancing ? ++sequence : sequence,
                    ...(completed === undefined ? {} : { result: completed }),
                  },
                }),
                "",
              );
            },
          },
        };
      finish = callback;
      signal = options.signal;
      if (args[1] === "commit")
        requestId = args[args.indexOf("--request-id") + 1] ?? "missing-request-id";
      return { stdin: { end: vi.fn() } };
    },
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  execute.mockReset();
});
const start = async () => {
  const result = new WindowsWorkspaceStorage().commitParent("storage.exe", "transaction");
  await vi.advanceTimersByTimeAsync(0);
  return { result };
};
const late = () => ({
  ok: true,
  requestId,
  parent: { compatibilityKey: { digest: "late-parent" }, allocatedBytes: 321 },
});
it("has no total deadline with advancing worker progress for 90 minutes", async () => {
  const { result } = await start();
  await vi.advanceTimersByTimeAsync(90 * 60_000);
  expect(signal.aborted).toBe(false);
  finish(null, success, "");
  await expect(result).resolves.toEqual({ parentId: "parent", allocatedBytes: 123 });
  expect(vi.getTimerCount()).toBe(0);
});
it("responsive service heartbeats do not hide stalled worker progress", async () => {
  advancing = false;
  const { result } = await start();
  const check = expect(result).rejects.toMatchObject({
    code: "storage.commit-outcome-unknown",
    message: expect.stringContaining("progress stalled"),
  });
  await vi.advanceTimersByTimeAsync(130_000);
  await check;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("reconciles lost response without resubmitting commit or abort", async () => {
  const { result } = await start();
  completed = late();
  finish(new Error("lost response"), "", "");
  await expect(result).resolves.toEqual({ parentId: "late-parent", allocatedBytes: 321 });
  expect(execute.mock.calls.filter((c) => c[1][1] === "commit")).toHaveLength(1);
  expect(execute.mock.calls.some((c) => c[1][1] === "abort")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("accepts observed completion before the original CLI returns", async () => {
  const { result } = await start();
  completed = late();
  await vi.advanceTimersByTimeAsync(5000);
  await expect(result).resolves.toMatchObject({ parentId: "late-parent" });
  expect(signal.aborted).toBe(true);
});
it.each(["disconnect", "restart"])("preserves uncertainty after %s", async (mode) => {
  const { result } = await start();
  disconnected = mode === "disconnect";
  restarted = mode === "restart";
  const check = expect(result).rejects.toMatchObject({ code: "storage.commit-outcome-unknown" });
  await vi.advanceTimersByTimeAsync(30_000);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
it("requires service capability before commit submission", async () => {
  unsupported = true;
  await expect(
    new WindowsWorkspaceStorage().commitParent("storage.exe", "transaction"),
  ).rejects.toMatchObject({ code: "storage.heartbeat-unavailable" });
  expect(execute.mock.calls.every((c) => c[1][0] === "control")).toBe(true);
});
it("rejects obsolete total-timeout configuration before begin", async () => {
  vi.stubEnv("HONEYBEE_PARENT_COMMIT_TIMEOUT_MS", "600000");
  await expect(
    new WindowsWorkspaceStorage().beginParent("storage.exe", "key"),
  ).rejects.toMatchObject({ code: "storage.invalid-timeout" });
  expect(execute).not.toHaveBeenCalled();
});
it.each(["", " ", "0", "-1", "1.5", "1e6", "abc", "2147483648"])(
  "rejects invalid idle interval %j before begin",
  async (value) => {
    vi.stubEnv("HONEYBEE_PARENT_COMMIT_IDLE_TIMEOUT_MS", value);
    await expect(
      new WindowsWorkspaceStorage().beginParent("storage.exe", "key"),
    ).rejects.toMatchObject({ code: "storage.invalid-timeout" });
    expect(execute).not.toHaveBeenCalled();
  },
);
it.each(["begin", "abort", "status"])(
  "retains ordinary command timeout for %s",
  async (operation) => {
    const storage = new WindowsWorkspaceStorage();
    const result =
      operation === "begin"
        ? storage.beginParent("storage.exe", "key")
        : operation === "abort"
          ? storage.abortParent("storage.exe", "transaction")
          : storage.status("storage.exe");
    const check = expect(result).rejects.toMatchObject({ code: "storage.command-timeout" });
    await vi.advanceTimersByTimeAsync(120_000);
    await check;
  },
);
it.each(["parent-verification-failed", "storage-capacity-unavailable", "parent-commit-failed"])(
  "preserves confirmed failure %s",
  async (code) => {
    const { result } = await start();
    completed = { ok: false, requestId, error: { code, message: "failed" } };
    finish(new Error("lost"), "", "");
    await expect(result).rejects.toMatchObject({
      code: "storage.operation-failed",
      upstreamCode: code,
    });
  },
);
it("rejects completed results for another request", async () => {
  const { result } = await start();
  completed = { ...late(), requestId: "other" };
  finish(new Error("lost"), "", "");
  await expect(result).rejects.toMatchObject({ code: "storage.commit-outcome-unknown" });
});
