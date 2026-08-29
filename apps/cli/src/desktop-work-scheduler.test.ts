import { describe, expect, it } from "vitest";

import { DesktopWorkScheduler } from "./desktop-work-scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("DesktopWorkScheduler", () => {
  it("bounds all callers and returns slots after failures", async () => {
    const scheduler = new DesktopWorkScheduler(1);
    const first = deferred();
    const order: string[] = [];
    const a = scheduler.withSlot({ priority: "validation" }, async () => {
      order.push("a");
      await first.promise;
      throw new Error("expected");
    });
    const b = scheduler.withSlot({ priority: "validation" }, async () => {
      order.push("b");
      return 2;
    });
    await Promise.resolve();
    expect(scheduler.snapshot()).toEqual({ capacity: 1, active: 1, queued: 1 });
    first.resolve();
    await expect(a).rejects.toThrow("expected");
    await expect(b).resolves.toBe(2);
    expect(order).toEqual(["a", "b"]);
    expect(scheduler.snapshot()).toEqual({ capacity: 1, active: 0, queued: 0 });
  });

  it("uses priority and FIFO without preempting an active body", async () => {
    const scheduler = new DesktopWorkScheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const active = scheduler.withSlot({ priority: "background" }, async () => {
      order.push("active");
      await gate.promise;
    });
    await Promise.resolve();
    const background = scheduler.withSlot({ priority: "background" }, async () => {
      order.push("background");
    });
    const interactiveA = scheduler.withSlot({ priority: "interactive" }, async () => {
      order.push("interactive-a");
    });
    const interactiveB = scheduler.withSlot({ priority: "interactive" }, async () => {
      order.push("interactive-b");
    });
    gate.resolve();
    await Promise.all([active, background, interactiveA, interactiveB]);
    expect(order).toEqual(["active", "interactive-a", "interactive-b", "background"]);
  });

  it("removes an aborted queued request without consuming capacity", async () => {
    const scheduler = new DesktopWorkScheduler(1);
    const gate = deferred();
    const active = scheduler.withSlot({ priority: "validation" }, () => gate.promise);
    const controller = new AbortController();
    const queued = scheduler.withSlot(
      { priority: "interactive", signal: controller.signal },
      async () => "unreachable",
    );
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    gate.resolve();
    await active;
    expect(scheduler.snapshot()).toEqual({ capacity: 1, active: 0, queued: 0 });
  });

  it("does not admit a ticket before its own queued hook is durable", async () => {
    const scheduler = new DesktopWorkScheduler(2);
    const firstQueued = deferred();
    const bodies: string[] = [];
    const first = scheduler.withSlot(
      { priority: "interactive", onQueued: () => firstQueued.promise },
      async () => {
        bodies.push("first");
      },
    );
    const second = scheduler.withSlot(
      { priority: "background", onQueued: async () => undefined },
      async () => {
        bodies.push("second");
      },
    );
    await second;
    expect(bodies).toEqual(["second"]);
    expect(scheduler.snapshot()).toEqual({ capacity: 2, active: 0, queued: 1 });
    firstQueued.resolve();
    await first;
    expect(bodies).toEqual(["second", "first"]);
  });

  it("never starts a ticket whose queued hook rejects", async () => {
    const scheduler = new DesktopWorkScheduler(2);
    let rejectQueued!: (error: Error) => void;
    const queued = new Promise<void>((_resolve, reject) => {
      rejectQueued = reject;
    });
    let started = false;
    const rejected = scheduler.withSlot(
      { priority: "interactive", onQueued: () => queued },
      async () => {
        started = true;
      },
    );
    await scheduler.withSlot(
      { priority: "background", onQueued: async () => undefined },
      async () => undefined,
    );
    rejectQueued(new Error("journal failed"));
    await expect(rejected).rejects.toThrow("journal failed");
    expect(started).toBe(false);
  });

  it("removes a ticket whose queued hook throws synchronously", async () => {
    const scheduler = new DesktopWorkScheduler(1);
    let ran = false;
    await expect(
      scheduler.withSlot(
        {
          priority: "interactive",
          onQueued: () => {
            throw new Error("journal failed");
          },
        },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow("journal failed");
    expect(ran).toBe(false);
    expect(scheduler.snapshot()).toEqual({ capacity: 1, active: 0, queued: 0 });
  });
});
