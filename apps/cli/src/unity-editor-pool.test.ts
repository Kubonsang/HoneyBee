import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EventIdSchema, ResourceIdSchema, RunIdSchema, StepIdSchema } from "@honeybee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileUnityEditorPoolCoordinator } from "./unity-editor-pool.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-pool-"));
  roots.push(root);
  return root;
};

const request = (priority: "interactive" | "validation" | "background", workId: string) => ({
  poolId: ResourceIdSchema.parse("unity-editors"),
  requestId: EventIdSchema.parse(randomUUID()),
  ownerRunId: RunIdSchema.parse(randomUUID()),
  ownerWorkId: StepIdSchema.parse(workId),
  priority,
});

describe("FileUnityEditorPoolCoordinator", () => {
  it("distinguishes an undeclared pool from corrupt declared history", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    expect(await pool.inspectOptional(ResourceIdSchema.parse("unity-editors"))).toBeUndefined();
    await expect(pool.inspect(ResourceIdSchema.parse("unity-editors"))).rejects.toMatchObject({
      code: "validation.invalid-workflow",
    });
  });

  it("assigns free slots atomically and permits different Editors concurrently", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    await pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 2 });
    const first = request("validation", "work-a");
    const second = request("validation", "work-b");
    await Promise.all([pool.enqueue(first), pool.enqueue(second)]);

    const [left, right] = await Promise.all([pool.acquire(first), pool.acquire(second)]);
    expect(new Set([left.slotId, right.slotId])).toEqual(new Set(["editor-1", "editor-2"]));
    await Promise.all([pool.release(left), pool.release(right)]);
    expect((await pool.status(first)).state).toBe("released");
    expect((await pool.status(second)).state).toBe("released");
  });

  it("uses priority then FIFO without preempting an active lease", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    await pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 });
    const blocker = request("background", "blocker");
    await pool.enqueue(blocker);
    const blockerLease = await pool.acquire(blocker);

    const background = request("background", "work-bg");
    const firstInteractive = request("interactive", "work-i1");
    const secondInteractive = request("interactive", "work-i2");
    await pool.enqueue(background);
    const firstTicket = await pool.enqueue(firstInteractive);
    const secondTicket = await pool.enqueue(secondInteractive);
    expect(firstTicket.ticket).toBeLessThan(secondTicket.ticket);
    expect((await pool.inspect(ResourceIdSchema.parse("unity-editors"))).queued).toEqual([
      firstTicket,
      secondTicket,
      expect.objectContaining({ requestId: background.requestId }),
    ]);
    await pool.release(blockerLease);

    expect(await pool.inspect(ResourceIdSchema.parse("unity-editors"))).toMatchObject({
      capacity: 1,
      active: [expect.objectContaining({ requestId: firstInteractive.requestId })],
    });

    const firstLease = await pool.acquire(firstInteractive);
    expect(firstLease.slotId).toBe("editor-1");
    expect((await pool.status(background)).state).toBe("queued");
    await pool.release(firstLease);
    const secondLease = await pool.acquire(secondInteractive);
    await pool.release(secondLease);
    const backgroundLease = await pool.acquire(background);
    await pool.release(backgroundLease);
  });

  it("keeps queued cancellation durable and never releases active ownership through cancel", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    await pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 });
    const active = request("validation", "active");
    const queued = request("validation", "queued");
    await pool.enqueue(active);
    const lease = await pool.acquire(active);
    await pool.enqueue(queued);
    await pool.cancel(queued);
    expect((await pool.status(queued)).state).toBe("cancelled");
    await expect(pool.cancel(active)).rejects.toMatchObject({
      code: "validation.invalid-workflow",
    });
    await pool.release(lease);
  });

  it("releases a slot granted while its acquire is being aborted", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    await pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 });
    const blocker = request("validation", "blocker");
    const aborted = request("validation", "aborted");
    await pool.enqueue(blocker);
    const blockerLease = await pool.acquire(blocker);
    await pool.enqueue(aborted);

    const controller = new AbortController();
    const waiting = pool.acquire(aborted, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await pool.release(blockerLease);

    await expect(waiting).rejects.toMatchObject({ code: "agent.cancelled" });
    expect(await pool.status(aborted)).toMatchObject({ state: "released" });

    const next = request("validation", "next");
    await pool.enqueue(next);
    const nextLease = await pool.acquire(next);
    expect(nextLease.slotId).toBe("editor-1");
    await pool.release(nextLease);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a junction in every state or lock path component",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await mkdir(path.join(outside, "target"));
      await symlink(
        path.join(outside, "target"),
        path.join(root, ".unity-editor-pools"),
        "junction",
      );
      const pool = new FileUnityEditorPoolCoordinator(root);
      await expect(
        pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 }),
      ).rejects.toMatchObject({ code: "run.indeterminate" });

      await rm(path.join(root, ".unity-editor-pools"), { force: true });
      await rm(path.join(root, ".unity-editor-pool-locks"), { recursive: true, force: true });
      await symlink(
        path.join(outside, "target"),
        path.join(root, ".unity-editor-pool-locks"),
        "junction",
      );
      await expect(
        pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 }),
      ).rejects.toMatchObject({ code: "run.indeterminate" });
    },
  );

  it("leaves a waiting request queued until capacity is released", async () => {
    const root = await temporaryRoot();
    const pool = new FileUnityEditorPoolCoordinator(root);
    await pool.declare({ poolId: ResourceIdSchema.parse("unity-editors"), capacity: 1 });
    const first = request("validation", "first");
    const second = request("validation", "second");
    await pool.enqueue(first);
    const firstLease = await pool.acquire(first);
    await pool.enqueue(second);
    let settled = false;
    const waiting = pool.acquire(second).then((lease) => {
      settled = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await pool.release(firstLease);
    const secondLease = await waiting;
    expect(settled).toBe(true);
    await pool.release(secondLease);
    await vi.waitFor(async () => expect((await pool.status(second)).state).toBe("released"));
  });
});
