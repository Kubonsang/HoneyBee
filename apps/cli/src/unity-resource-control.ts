import { randomUUID } from "node:crypto";

import {
  EventIdSchema,
  ResourceIdSchema,
  RunIdSchema,
  type ResourceId,
  type RunId,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";

export interface UnityResourceRequest {
  readonly resourceId: ResourceId;
  readonly requestId: ReturnType<typeof EventIdSchema.parse>;
  readonly ownerRunId: RunId;
}

export interface UnityResourceTicket extends UnityResourceRequest {
  readonly ticket: number;
}

export interface UnityResourceLease extends UnityResourceTicket {
  readonly leaseId: ReturnType<typeof EventIdSchema.parse>;
}

export type UnityResourceStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "queued"; ticket: UnityResourceTicket }>
  | Readonly<{ state: "active"; lease: UnityResourceLease }>
  | Readonly<{ state: "cancelled"; ticket: UnityResourceTicket }>
  | Readonly<{ state: "released"; lease: UnityResourceLease }>;

export interface UnityResourceCoordinator {
  enqueue(request: UnityResourceRequest): Promise<UnityResourceTicket>;
  acquire(
    requestId: UnityResourceRequest["requestId"],
    signal?: AbortSignal,
  ): Promise<UnityResourceLease>;
  status(requestId: UnityResourceRequest["requestId"]): Promise<UnityResourceStatus>;
  cancel(requestId: UnityResourceRequest["requestId"]): Promise<void>;
  release(lease: UnityResourceLease): Promise<void>;
}

interface Waiter {
  readonly ticket: UnityResourceTicket;
  resolve?: (lease: UnityResourceLease) => void;
  reject?: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface ResourceState {
  nextTicket: number;
  active: UnityResourceLease | undefined;
  readonly queue: Waiter[];
}

export class BatchLocalUnityResourceCoordinator implements UnityResourceCoordinator {
  readonly #resources = new Map<ResourceId, ResourceState>();
  readonly #requests = new Map<string, UnityResourceStatus>();

  public constructor(private readonly randomId: () => string = randomUUID) {}

  public async enqueue(requestValue: UnityResourceRequest): Promise<UnityResourceTicket> {
    const request: UnityResourceRequest = {
      resourceId: ResourceIdSchema.parse(requestValue.resourceId),
      requestId: EventIdSchema.parse(requestValue.requestId),
      ownerRunId: RunIdSchema.parse(requestValue.ownerRunId),
    };
    const existing = this.#requests.get(request.requestId);
    if (existing !== undefined) {
      if (existing.state === "missing") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Stored resource request state is inconsistent.",
        );
      }
      const identity =
        existing.state === "queued" || existing.state === "cancelled"
          ? existing.ticket
          : existing.lease;
      if (
        identity.resourceId !== request.resourceId ||
        identity.ownerRunId !== request.ownerRunId
      ) {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "Resource request ID was reused with different ownership.",
        );
      }
      return identity;
    }
    const state = this.#state(request.resourceId);
    const ticket = { ...request, ticket: ++state.nextTicket };
    state.queue.push({ ticket });
    this.#requests.set(request.requestId, { state: "queued", ticket });
    this.#grant(state);
    return ticket;
  }

  public async acquire(
    requestIdValue: UnityResourceRequest["requestId"],
    signal?: AbortSignal,
  ): Promise<UnityResourceLease> {
    const requestId = EventIdSchema.parse(requestIdValue);
    const current = this.#requests.get(requestId);
    if (current?.state === "active") return current.lease;
    if (current?.state !== "queued") {
      throw new HoneyBeeCoreError("validation.invalid-workflow", "Resource request is not queued.");
    }
    if (signal?.aborted === true) {
      await this.cancel(requestId);
      throw new HoneyBeeCoreError("agent.cancelled", "Resource wait was cancelled.");
    }
    const state = this.#state(current.ticket.resourceId);
    const waiter = state.queue.find((candidate) => candidate.ticket.requestId === requestId);
    if (waiter === undefined) {
      const afterGrant = this.#requests.get(requestId);
      if (afterGrant?.state === "active") return afterGrant.lease;
      throw new HoneyBeeCoreError("run.indeterminate", "Resource queue state is inconsistent.");
    }
    return new Promise<UnityResourceLease>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      if (signal !== undefined) {
        const abort = () => {
          void this.cancel(requestId).catch(reject);
        };
        waiter.signal = signal;
        waiter.abort = abort;
        signal.addEventListener("abort", abort, { once: true });
      }
      this.#grant(state);
    });
  }

  public async status(
    requestIdValue: UnityResourceRequest["requestId"],
  ): Promise<UnityResourceStatus> {
    return this.#requests.get(EventIdSchema.parse(requestIdValue)) ?? { state: "missing" };
  }

  public async cancel(requestIdValue: UnityResourceRequest["requestId"]): Promise<void> {
    const requestId = EventIdSchema.parse(requestIdValue);
    const current = this.#requests.get(requestId);
    if (current === undefined || current.state === "missing" || current.state === "cancelled")
      return;
    if (current.state === "active") {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "An acquired resource must be released.",
      );
    }
    if (current.state === "released") return;
    const state = this.#state(current.ticket.resourceId);
    const index = state.queue.findIndex((candidate) => candidate.ticket.requestId === requestId);
    if (index >= 0) {
      const [waiter] = state.queue.splice(index, 1);
      if (waiter?.signal !== undefined && waiter.abort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      waiter?.reject?.(new HoneyBeeCoreError("agent.cancelled", "Resource wait was cancelled."));
    }
    this.#requests.set(requestId, { state: "cancelled", ticket: current.ticket });
    this.#grant(state);
  }

  public async release(leaseValue: UnityResourceLease): Promise<void> {
    const lease: UnityResourceLease = {
      resourceId: ResourceIdSchema.parse(leaseValue.resourceId),
      requestId: EventIdSchema.parse(leaseValue.requestId),
      ownerRunId: RunIdSchema.parse(leaseValue.ownerRunId),
      ticket: leaseValue.ticket,
      leaseId: EventIdSchema.parse(leaseValue.leaseId),
    };
    const state = this.#state(lease.resourceId);
    const current = state.active;
    if (current === undefined) {
      const observation = this.#requests.get(lease.requestId);
      if (observation?.state === "released" && observation.lease.leaseId === lease.leaseId) return;
      throw new HoneyBeeCoreError("run.indeterminate", "Resource lease is not active.");
    }
    if (
      current.leaseId !== lease.leaseId ||
      current.requestId !== lease.requestId ||
      current.ownerRunId !== lease.ownerRunId ||
      current.ticket !== lease.ticket
    ) {
      throw new HoneyBeeCoreError("run.indeterminate", "Resource lease ownership does not match.");
    }
    state.active = undefined;
    this.#requests.set(lease.requestId, { state: "released", lease: current });
    this.#grant(state);
  }

  #state(resourceId: ResourceId): ResourceState {
    const existing = this.#resources.get(resourceId);
    if (existing !== undefined) return existing;
    const created: ResourceState = { nextTicket: 0, active: undefined, queue: [] };
    this.#resources.set(resourceId, created);
    return created;
  }

  #grant(state: ResourceState): void {
    if (state.active !== undefined) return;
    const waiter = state.queue[0];
    if (waiter === undefined || waiter.resolve === undefined) return;
    state.queue.shift();
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    const lease: UnityResourceLease = {
      ...waiter.ticket,
      leaseId: EventIdSchema.parse(this.randomId()),
    };
    state.active = lease;
    this.#requests.set(lease.requestId, { state: "active", lease });
    waiter.resolve(lease);
  }
}
