import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  EventIdSchema,
  ResourceIdSchema,
  RunIdSchema,
  StepIdSchema,
  UnityEditorPoolEventV2Schema,
  UnityEditorSlotIdSchema,
  UnityWorkPrioritySchema,
  type ResourceId,
  type RunId,
  type StepId,
  type UnityEditorPoolEventV2,
  type UnityEditorSlotId,
  type UnityWorkPriority,
} from "@honeybee/orchestration-contracts";
import { FileRunControl, HoneyBeeCoreError } from "@honeybee/core";

import {
  readRecoveredImmutableFile,
  UnsafeImmutablePublicationError,
} from "./immutable-publication.js";

const POLL_MS = 50;
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const EVENT_NAME = /^(\d{20})\.json$/u;
const PRIORITY: Readonly<Record<UnityWorkPriority, number>> = {
  interactive: 0,
  validation: 1,
  background: 2,
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface UnityEditorPoolDefinition {
  readonly poolId: ResourceId;
  readonly capacity: number;
}

export interface UnityEditorPoolRequest {
  readonly poolId: ResourceId;
  readonly requestId: ReturnType<typeof EventIdSchema.parse>;
  readonly ownerRunId: RunId;
  readonly ownerWorkId: StepId;
  readonly priority: UnityWorkPriority;
}

export interface UnityEditorPoolTicket extends UnityEditorPoolRequest {
  readonly ticket: number;
}

export interface UnityEditorPoolLease extends UnityEditorPoolTicket {
  readonly leaseId: ReturnType<typeof EventIdSchema.parse>;
  readonly slotId: UnityEditorSlotId;
}

export type UnityEditorPoolLocator = Pick<UnityEditorPoolRequest, "poolId" | "requestId">;

export type UnityEditorPoolStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "queued"; ticket: UnityEditorPoolTicket }>
  | Readonly<{ state: "active"; lease: UnityEditorPoolLease }>
  | Readonly<{ state: "cancelled"; ticket: UnityEditorPoolTicket }>
  | Readonly<{ state: "released"; lease: UnityEditorPoolLease }>;

export interface UnityEditorPoolSnapshot {
  readonly poolId: ResourceId;
  readonly capacity: number;
  readonly active: readonly UnityEditorPoolLease[];
  readonly queued: readonly UnityEditorPoolTicket[];
}

export interface UnityEditorPoolCoordinator {
  declare(definition: UnityEditorPoolDefinition): Promise<void>;
  enqueue(request: UnityEditorPoolRequest): Promise<UnityEditorPoolTicket>;
  acquire(locator: UnityEditorPoolLocator, signal?: AbortSignal): Promise<UnityEditorPoolLease>;
  status(locator: UnityEditorPoolLocator): Promise<UnityEditorPoolStatus>;
  inspect(poolId: ResourceId): Promise<UnityEditorPoolSnapshot>;
  cancel(locator: UnityEditorPoolLocator): Promise<void>;
  release(lease: UnityEditorPoolLease): Promise<void>;
}

interface PoolSnapshot {
  readonly capacity: number;
  readonly nextTicket: number;
  readonly requests: ReadonlyMap<string, UnityEditorPoolStatus>;
  readonly activeBySlot: ReadonlyMap<UnityEditorSlotId, UnityEditorPoolLease>;
  readonly events: readonly UnityEditorPoolEventV2[];
}

const ticketFrom = (
  event: Extract<
    UnityEditorPoolEventV2,
    {
      type:
        | "editor-pool.queued"
        | "editor-pool.cancelled"
        | "editor-pool.acquired"
        | "editor-pool.released";
    }
  >,
): UnityEditorPoolTicket => ({
  poolId: event.poolId,
  requestId: event.requestId,
  ownerRunId: event.ownerRunId,
  ownerWorkId: event.ownerWorkId,
  priority: event.priority,
  ticket: event.ticket,
});

const leaseFrom = (
  event: Extract<UnityEditorPoolEventV2, { type: "editor-pool.acquired" | "editor-pool.released" }>,
): UnityEditorPoolLease => ({
  ...ticketFrom(event),
  leaseId: event.leaseId,
  slotId: event.slotId,
});

const sameTicket = (left: UnityEditorPoolTicket, right: UnityEditorPoolTicket): boolean =>
  left.poolId === right.poolId &&
  left.requestId === right.requestId &&
  left.ownerRunId === right.ownerRunId &&
  left.ownerWorkId === right.ownerWorkId &&
  left.priority === right.priority &&
  left.ticket === right.ticket;

const sameLease = (left: UnityEditorPoolLease, right: UnityEditorPoolLease): boolean =>
  sameTicket(left, right) && left.leaseId === right.leaseId && left.slotId === right.slotId;

const lockRunIdFor = (poolId: ResourceId): RunId => {
  const bytes = createHash("sha256")
    .update("honeybee-unity-editor-pool-lock-v2\0", "utf8")
    .update(poolId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return RunIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

const ensureRealDirectoryPath = async (
  rootDirectory: string,
  components: readonly string[],
): Promise<string> => {
  let directory = path.resolve(rootDirectory);
  await mkdir(directory, { recursive: true });
  const rootEntry = await lstat(directory);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new HoneyBeeCoreError(
      "run.indeterminate",
      "Editor pool state root is not a real directory.",
    );
  }
  for (const component of components) {
    const child = path.resolve(directory, component);
    if (path.dirname(child) !== directory) {
      throw new HoneyBeeCoreError("run.indeterminate", "Editor pool state path escaped its root.");
    }
    try {
      await mkdir(child);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor pool state path could not be prepared.",
        );
      }
    }
    const entry = await lstat(child);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HoneyBeeCoreError("run.indeterminate", "Editor pool state path contains a link.");
    }
    directory = child;
  }
  return directory;
};

const validatedRequest = (request: UnityEditorPoolRequest): UnityEditorPoolRequest => ({
  poolId: ResourceIdSchema.parse(request.poolId),
  requestId: EventIdSchema.parse(request.requestId),
  ownerRunId: RunIdSchema.parse(request.ownerRunId),
  ownerWorkId: StepIdSchema.parse(request.ownerWorkId),
  priority: UnityWorkPrioritySchema.parse(request.priority),
});

export class FileUnityEditorPoolCoordinator implements UnityEditorPoolCoordinator {
  readonly #root: string;
  readonly #locks: FileRunControl;

  public constructor(
    rootDirectory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly randomId: () => string = randomUUID,
  ) {
    this.#root = path.resolve(rootDirectory);
    this.#locks = new FileRunControl(path.join(this.#root, ".unity-editor-pool-locks", "v2"));
  }

  public async declare(definitionValue: UnityEditorPoolDefinition): Promise<void> {
    const definition = {
      poolId: ResourceIdSchema.parse(definitionValue.poolId),
      capacity: definitionValue.capacity,
    };
    if (
      !Number.isInteger(definition.capacity) ||
      definition.capacity < 1 ||
      definition.capacity > 32
    ) {
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Editor pool capacity is invalid.",
      );
    }
    await this.#withLock(definition.poolId, async () => {
      const events = await this.#readEvents(definition.poolId);
      const declared = events[0];
      if (declared === undefined) {
        await this.#append(
          definition.poolId,
          UnityEditorPoolEventV2Schema.parse({
            schemaVersion: 2,
            eventId: EventIdSchema.parse(this.randomId()),
            sequence: 1,
            timestamp: this.now().toISOString(),
            type: "editor-pool.declared",
            poolId: definition.poolId,
            capacity: definition.capacity,
          }),
        );
        return;
      }
      if (declared.type !== "editor-pool.declared" || declared.capacity !== definition.capacity) {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "Editor pool capacity differs from its durable declaration.",
        );
      }
    });
  }

  public async enqueue(requestValue: UnityEditorPoolRequest): Promise<UnityEditorPoolTicket> {
    const request = validatedRequest(requestValue);
    return this.#withLock(request.poolId, async () => {
      const snapshot = await this.#snapshot(request.poolId);
      const existing = snapshot.requests.get(request.requestId);
      if (existing !== undefined && existing.state !== "missing") {
        const identity =
          existing.state === "queued" || existing.state === "cancelled"
            ? existing.ticket
            : existing.lease;
        if (
          identity.ownerRunId !== request.ownerRunId ||
          identity.ownerWorkId !== request.ownerWorkId ||
          identity.priority !== request.priority
        ) {
          throw new HoneyBeeCoreError(
            "validation.invalid-workflow",
            "Editor pool request ID was reused with different ownership.",
          );
        }
        return identity;
      }
      const ticket: UnityEditorPoolTicket = { ...request, ticket: snapshot.nextTicket + 1 };
      await this.#appendRequest(snapshot.events, "editor-pool.queued", ticket);
      return ticket;
    });
  }

  public async acquire(
    locatorValue: UnityEditorPoolLocator,
    signal?: AbortSignal,
  ): Promise<UnityEditorPoolLease> {
    const locator = {
      poolId: ResourceIdSchema.parse(locatorValue.poolId),
      requestId: EventIdSchema.parse(locatorValue.requestId),
    };
    const aborted = (): boolean => signal?.aborted === true;
    for (;;) {
      if (aborted()) {
        await this.#abortAcquire(locator);
        throw new HoneyBeeCoreError("agent.cancelled", "Editor pool wait was cancelled.");
      }
      const status = await this.#withLock(locator.poolId, async () => {
        await this.#grant(locator.poolId);
        return (
          (await this.#snapshot(locator.poolId)).requests.get(locator.requestId) ?? {
            state: "missing" as const,
          }
        );
      });
      if (status.state === "active" || status.state === "released") {
        if (aborted()) {
          await this.#abortAcquire(locator);
          throw new HoneyBeeCoreError("agent.cancelled", "Editor pool wait was cancelled.");
        }
        return status.lease;
      }
      if (status.state !== "queued") {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "Editor pool request is not queued.",
        );
      }
      await delay(POLL_MS);
    }
  }

  async #abortAcquire(locator: UnityEditorPoolLocator): Promise<void> {
    await this.#withLock(locator.poolId, async () => {
      await this.#grant(locator.poolId);
      const snapshot = await this.#snapshot(locator.poolId);
      const status = snapshot.requests.get(locator.requestId);
      if (status?.state === "queued") {
        await this.#appendRequest(snapshot.events, "editor-pool.cancelled", status.ticket);
        return;
      }
      if (status?.state === "active") {
        await this.#append(
          locator.poolId,
          UnityEditorPoolEventV2Schema.parse({
            schemaVersion: 2,
            eventId: EventIdSchema.parse(this.randomId()),
            sequence: snapshot.events.length + 1,
            timestamp: this.now().toISOString(),
            type: "editor-pool.released",
            ...status.lease,
          }),
        );
        await this.#grant(locator.poolId);
        return;
      }
      if (status?.state === "cancelled" || status?.state === "released") return;
      throw new HoneyBeeCoreError(
        "validation.invalid-workflow",
        "Editor pool request is not queued.",
      );
    });
  }

  public async status(locatorValue: UnityEditorPoolLocator): Promise<UnityEditorPoolStatus> {
    const poolId = ResourceIdSchema.parse(locatorValue.poolId);
    const requestId = EventIdSchema.parse(locatorValue.requestId);
    const snapshot = await this.#snapshot(poolId);
    return snapshot.requests.get(requestId) ?? { state: "missing" };
  }

  public async inspect(poolIdValue: ResourceId): Promise<UnityEditorPoolSnapshot> {
    const inspected = await this.inspectOptional(poolIdValue);
    if (inspected === undefined) {
      throw new HoneyBeeCoreError("validation.invalid-workflow", "Editor pool is not declared.");
    }
    return inspected;
  }

  public async inspectOptional(
    poolIdValue: ResourceId,
  ): Promise<UnityEditorPoolSnapshot | undefined> {
    const poolId = ResourceIdSchema.parse(poolIdValue);
    if ((await this.#readEvents(poolId)).length === 0) return undefined;
    const snapshot = await this.#snapshot(poolId);
    const active = [...snapshot.activeBySlot.values()].sort((left, right) =>
      left.slotId.localeCompare(right.slotId),
    );
    const queued = [...snapshot.requests.values()]
      .filter(
        (status): status is Extract<UnityEditorPoolStatus, { state: "queued" }> =>
          status.state === "queued",
      )
      .map((status) => status.ticket)
      .sort(
        (left, right) =>
          PRIORITY[left.priority] - PRIORITY[right.priority] || left.ticket - right.ticket,
      );
    return { poolId, capacity: snapshot.capacity, active, queued };
  }

  public async cancel(locatorValue: UnityEditorPoolLocator): Promise<void> {
    const poolId = ResourceIdSchema.parse(locatorValue.poolId);
    const requestId = EventIdSchema.parse(locatorValue.requestId);
    await this.#withLock(poolId, async () => {
      const snapshot = await this.#snapshot(poolId);
      const status = snapshot.requests.get(requestId);
      if (
        status === undefined ||
        status.state === "missing" ||
        status.state === "cancelled" ||
        status.state === "released"
      )
        return;
      if (status.state === "active") {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "An acquired Editor slot must be released.",
        );
      }
      await this.#appendRequest(snapshot.events, "editor-pool.cancelled", status.ticket);
    });
  }

  public async release(leaseValue: UnityEditorPoolLease): Promise<void> {
    const lease: UnityEditorPoolLease = {
      ...validatedRequest(leaseValue),
      ticket: leaseValue.ticket,
      leaseId: EventIdSchema.parse(leaseValue.leaseId),
      slotId: UnityEditorSlotIdSchema.parse(leaseValue.slotId),
    };
    await this.#withLock(lease.poolId, async () => {
      const snapshot = await this.#snapshot(lease.poolId);
      const status = snapshot.requests.get(lease.requestId);
      if (status?.state === "released" && sameLease(status.lease, lease)) return;
      if (status?.state !== "active" || !sameLease(status.lease, lease)) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor pool lease ownership does not match.",
        );
      }
      const event = UnityEditorPoolEventV2Schema.parse({
        schemaVersion: 2,
        eventId: EventIdSchema.parse(this.randomId()),
        sequence: snapshot.events.length + 1,
        timestamp: this.now().toISOString(),
        type: "editor-pool.released",
        ...lease,
      });
      await this.#append(lease.poolId, event);
      await this.#grant(lease.poolId);
    });
  }

  async #grant(poolId: ResourceId): Promise<void> {
    for (;;) {
      const snapshot = await this.#snapshot(poolId);
      const freeSlots = Array.from({ length: snapshot.capacity }, (_, index) =>
        UnityEditorSlotIdSchema.parse(`editor-${index + 1}`),
      ).filter((slot) => !snapshot.activeBySlot.has(slot));
      if (freeSlots.length === 0) return;
      const queued = [...snapshot.requests.values()]
        .filter(
          (status): status is Extract<UnityEditorPoolStatus, { state: "queued" }> =>
            status.state === "queued",
        )
        .map((status) => status.ticket)
        .sort(
          (left, right) =>
            PRIORITY[left.priority] - PRIORITY[right.priority] || left.ticket - right.ticket,
        );
      const ticket = queued[0];
      const slotId = freeSlots[0];
      if (ticket === undefined || slotId === undefined) return;
      const lease: UnityEditorPoolLease = {
        ...ticket,
        leaseId: EventIdSchema.parse(this.randomId()),
        slotId,
      };
      await this.#append(
        poolId,
        UnityEditorPoolEventV2Schema.parse({
          schemaVersion: 2,
          eventId: EventIdSchema.parse(this.randomId()),
          sequence: snapshot.events.length + 1,
          timestamp: this.now().toISOString(),
          type: "editor-pool.acquired",
          ...lease,
        }),
      );
    }
  }

  async #appendRequest(
    events: readonly UnityEditorPoolEventV2[],
    type: "editor-pool.queued" | "editor-pool.cancelled",
    ticket: UnityEditorPoolTicket,
  ): Promise<void> {
    await this.#append(
      ticket.poolId,
      UnityEditorPoolEventV2Schema.parse({
        schemaVersion: 2,
        eventId: EventIdSchema.parse(this.randomId()),
        sequence: events.length + 1,
        timestamp: this.now().toISOString(),
        type,
        ...ticket,
      }),
    );
  }

  async #snapshot(poolId: ResourceId): Promise<PoolSnapshot> {
    const events = await this.#readEvents(poolId);
    const declared = events[0];
    if (declared?.type !== "editor-pool.declared") {
      throw new HoneyBeeCoreError("validation.invalid-workflow", "Editor pool is not declared.");
    }
    const requests = new Map<string, UnityEditorPoolStatus>();
    const activeBySlot = new Map<UnityEditorSlotId, UnityEditorPoolLease>();
    let nextTicket = 0;
    for (const event of events.slice(1)) {
      if (event.type === "editor-pool.declared") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor pool was declared more than once.",
        );
      }
      const existing = requests.get(event.requestId);
      if (event.type === "editor-pool.queued") {
        if (existing !== undefined || event.ticket <= nextTicket) {
          throw new HoneyBeeCoreError("run.indeterminate", "Editor pool queue order is corrupt.");
        }
        const ticket = ticketFrom(event);
        requests.set(event.requestId, { state: "queued", ticket });
        nextTicket = event.ticket;
      } else if (event.type === "editor-pool.acquired") {
        if (
          existing?.state !== "queued" ||
          !sameTicket(existing.ticket, ticketFrom(event)) ||
          activeBySlot.has(event.slotId)
        ) {
          throw new HoneyBeeCoreError("run.indeterminate", "Editor pool acquisition is corrupt.");
        }
        const lease = leaseFrom(event);
        activeBySlot.set(lease.slotId, lease);
        requests.set(event.requestId, { state: "active", lease });
      } else if (event.type === "editor-pool.cancelled") {
        if (existing?.state !== "queued" || !sameTicket(existing.ticket, ticketFrom(event))) {
          throw new HoneyBeeCoreError("run.indeterminate", "Editor pool cancellation is corrupt.");
        }
        requests.set(event.requestId, { state: "cancelled", ticket: existing.ticket });
      } else {
        if (existing?.state !== "active" || !sameLease(existing.lease, leaseFrom(event))) {
          throw new HoneyBeeCoreError("run.indeterminate", "Editor pool release is corrupt.");
        }
        activeBySlot.delete(existing.lease.slotId);
        requests.set(event.requestId, { state: "released", lease: existing.lease });
      }
    }
    return { capacity: declared.capacity, nextTicket, requests, activeBySlot, events };
  }

  async #readEvents(poolId: ResourceId): Promise<readonly UnityEditorPoolEventV2[]> {
    const directory = await this.#eventDirectory(poolId);
    const entries = await readdir(directory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (/^\.[0-9a-f-]{36}\.tmp$/iu.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new HoneyBeeCoreError(
            "run.indeterminate",
            "Editor pool temporary entry is unsafe.",
          );
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !EVENT_NAME.test(entry.name)) {
        throw new HoneyBeeCoreError("run.indeterminate", "Editor pool event directory is corrupt.");
      }
      names.push(entry.name);
    }
    names.sort();
    const events: UnityEditorPoolEventV2[] = [];
    for (const [index, name] of names.entries()) {
      const match = EVENT_NAME.exec(name);
      if (match?.[1] !== String(index + 1).padStart(20, "0")) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor pool event sequence is incomplete.",
        );
      }
      const filePath = path.join(directory, name);
      let bytes: Buffer;
      try {
        ({ bytes } = await readRecoveredImmutableFile(
          filePath,
          (candidate) => /^\.[0-9a-f-]{36}\.tmp$/iu.test(candidate),
          64 * 1024,
        ));
      } catch (error) {
        if (error instanceof UnsafeImmutablePublicationError) {
          throw new HoneyBeeCoreError(
            "run.indeterminate",
            "Editor pool event has an unrecognized hard link.",
          );
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new HoneyBeeCoreError("run.indeterminate", "Editor pool event is malformed.");
      }
      const event = UnityEditorPoolEventV2Schema.safeParse(parsed);
      if (!event.success || event.data.sequence !== index + 1 || event.data.poolId !== poolId) {
        throw new HoneyBeeCoreError("run.indeterminate", "Editor pool event identity is invalid.");
      }
      events.push(event.data);
    }
    return events;
  }

  async #append(poolId: ResourceId, event: UnityEditorPoolEventV2): Promise<void> {
    const directory = await this.#eventDirectory(poolId);
    const finalPath = path.join(directory, `${String(event.sequence).padStart(20, "0")}.json`);
    const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(event), "utf8");
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Editor pool event sequence already exists.",
        );
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  #eventDirectory(poolId: ResourceId): Promise<string> {
    return ensureRealDirectoryPath(this.#root, [
      ".unity-editor-pools",
      "v2",
      ResourceIdSchema.parse(poolId),
      "events",
    ]);
  }

  async #withLock<T>(poolId: ResourceId, operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await ensureRealDirectoryPath(this.#root, [".unity-editor-pool-locks", "v2"]);
        const lease = await this.#locks.acquire(lockRunIdFor(poolId));
        try {
          return await operation();
        } finally {
          await lease.release();
        }
      } catch (error) {
        if (
          !(error instanceof HoneyBeeCoreError) ||
          error.code !== "run.already-running" ||
          Date.now() >= deadline
        )
          throw error;
        await delay(LOCK_POLL_MS);
      }
    }
  }
}
