import { describe, expect, it, vi } from "vitest";

import { ExtensionLifecycleCoordinator } from "./extension-lifecycle-coordinator.js";

const flushable = () => ({ flush: vi.fn(async () => undefined) });

const setup = (viewShutdown: () => Promise<void> = async () => undefined) => {
  const calls: string[] = [];
  const console = {
    beginShutdown: vi.fn(() => calls.push("gate")),
    markActiveRunsStopping: vi.fn(async () => {
      calls.push("stopping");
    }),
    shutdownRuntime: vi.fn(async () => {
      calls.push("runtime-shutdown");
      return { stoppedRuns: 2, unresolvedRuns: 0 };
    }),
    interruptRemaining: vi.fn(async () => {
      calls.push("interrupt-remaining");
      return 1;
    }),
    flushRunState: vi.fn(async () => {
      calls.push("run-flush");
    }),
    disposeRuntime: vi.fn(async () => {
      calls.push("runtime-dispose");
    }),
    disposeListeners: vi.fn(() => calls.push("listeners-dispose")),
  };
  const view = {
    shutdown: vi.fn(async () => {
      calls.push("console-drain");
      await viewShutdown();
    }),
  };
  const attempts = flushable();
  const receipts = flushable();
  const runs = flushable();
  const lifecycle = new ExtensionLifecycleCoordinator({
    console,
    view,
    attempts,
    receipts,
    runs,
    timeoutMs: 50,
    cleanupTimeoutMs: 20,
  });
  return { attempts, calls, console, lifecycle, receipts, runs, view };
};

describe("ExtensionLifecycleCoordinator", () => {
  it("owns one idempotent ordered shutdown and flushes all durability tails", async () => {
    const fixture = setup();
    fixture.lifecycle.activate();
    const first = fixture.lifecycle.shutdown("context-dispose");
    const second = fixture.lifecycle.shutdown("extension-deactivate");
    expect(first).toBe(second);
    const report = await first;

    expect(report).toMatchObject({
      reason: "context-dispose",
      status: "completed",
      stoppedRuns: 2,
      unresolvedRuns: 0,
      persistenceFlushed: true,
      runtimeDisposed: true,
    });
    expect(fixture.console.shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toEqual([
      "gate",
      "console-drain",
      "stopping",
      "runtime-shutdown",
      "run-flush",
      "runtime-dispose",
      "listeners-dispose",
    ]);
    expect(fixture.attempts.flush).toHaveBeenCalledOnce();
    expect(fixture.receipts.flush).toHaveBeenCalledOnce();
    expect(fixture.runs.flush).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.state).toBe("stopped");
  });

  it("reports drain and Run persistence failures while continuing Runtime cleanup", async () => {
    const fixture = setup();
    fixture.view.shutdown.mockRejectedValue(new Error("draft drain failed"));
    fixture.console.markActiveRunsStopping.mockRejectedValue(new Error("Run save failed"));

    const report = await fixture.lifecycle.shutdown("activation-failure");

    expect(report.status).toBe("failed");
    expect(report.warnings).toEqual(["console-drain-failed", "run-stopping-save-failed"]);
    expect(fixture.console.shutdownRuntime).toHaveBeenCalledOnce();
    expect(fixture.console.disposeRuntime).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.state).toBe("stopped");
  });
  it("returns within the hard deadline, interrupts unresolved Runs and hard-disposes", async () => {
    const fixture = setup();
    fixture.console.shutdownRuntime.mockImplementation(() => new Promise<never>(() => undefined));
    const report = await fixture.lifecycle.shutdown("extension-deactivate");

    expect(report.status).toBe("timed-out");
    expect(report.warnings).toContain("shutdown-timeout");
    expect(report.unresolvedRuns).toBe(1);
    expect(fixture.console.interruptRemaining).toHaveBeenCalledOnce();
    expect(fixture.console.disposeRuntime).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.state).toBe("stopped");
  });
});
