import { randomUUID } from "node:crypto";

import { EventIdSchema, ResourceIdSchema, RunIdSchema } from "@honeybee/core";
import { describe, expect, it } from "vitest";

import { BatchLocalUnityResourceCoordinator } from "./unity-resource-control.js";

const request = (resourceId: string) => ({
  resourceId: ResourceIdSchema.parse(resourceId),
  requestId: EventIdSchema.parse(randomUUID()),
  ownerRunId: RunIdSchema.parse(randomUUID()),
});

describe("BatchLocalUnityResourceCoordinator", () => {
  it("serializes the same resource in FIFO order and allows distinct resources", async () => {
    const coordinator = new BatchLocalUnityResourceCoordinator();
    const first = request("unity-editor");
    const second = request("unity-editor");
    const independent = request("test-license");
    const [firstTicket, secondTicket, independentTicket] = await Promise.all([
      coordinator.enqueue(first),
      coordinator.enqueue(second),
      coordinator.enqueue(independent),
    ]);

    const firstLease = await coordinator.acquire(first.requestId);
    const independentLease = await coordinator.acquire(independent.requestId);
    expect(firstTicket.ticket).toBe(1);
    expect(secondTicket.ticket).toBe(2);
    expect(independentTicket.ticket).toBe(1);
    expect((await coordinator.status(second.requestId)).state).toBe("queued");

    let secondGranted = false;
    const secondLeasePromise = coordinator.acquire(second.requestId).then((lease) => {
      secondGranted = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    await coordinator.release(firstLease);
    const secondLease = await secondLeasePromise;
    expect(secondLease.ticket).toBe(2);

    await coordinator.release(secondLease);
    await coordinator.release(independentLease);
    expect((await coordinator.status(second.requestId)).state).toBe("released");
  });

  it("cancels a queued request without disturbing the active lease", async () => {
    const coordinator = new BatchLocalUnityResourceCoordinator();
    const first = request("unity-editor");
    const second = request("unity-editor");
    await coordinator.enqueue(first);
    await coordinator.enqueue(second);
    const lease = await coordinator.acquire(first.requestId);

    const waiting = coordinator.acquire(second.requestId);
    await coordinator.cancel(second.requestId);
    expect((await coordinator.status(second.requestId)).state).toBe("cancelled");
    await expect(waiting).rejects.toMatchObject({ code: "agent.cancelled" });
    await expect(coordinator.acquire(second.requestId)).rejects.toMatchObject({
      code: "validation.invalid-workflow",
    });
    await coordinator.release(lease);
  });

  it("rejects request ID reuse with different ownership", async () => {
    const coordinator = new BatchLocalUnityResourceCoordinator();
    const original = request("unity-editor");
    await coordinator.enqueue(original);

    await expect(
      coordinator.enqueue({ ...original, ownerRunId: RunIdSchema.parse(randomUUID()) }),
    ).rejects.toMatchObject({ code: "validation.invalid-workflow" });
  });
});
