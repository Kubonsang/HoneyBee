import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  EventIdSchema,
  ResourceIdSchema,
  RunIdSchema,
  UnityGlobalResourceEventV1Schema,
  type ResourceId,
  type RunId,
  type UnityGlobalResourceEventV1,
} from "@honeybee/orchestration-contracts";
import { FileRunControl, HoneyBeeCoreError } from "@honeybee/core";

import type {
  UnityResourceCoordinator,
  UnityResourceLease,
  UnityResourceLocator,
  UnityResourceRequest,
  UnityResourceStatus,
  UnityResourceTicket,
} from "./unity-resource-control.js";

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const ACQUIRE_POLL_MS = 50;
const EVENT_NAME = /^(\d{20})\.json$/u;
const PUBLISHED_READ_ATTEMPTS = 16;
const TRANSIENT_READ_ERRORS = new Set(["EACCES", "EBUSY", "ENOENT", "EPERM"]);

interface EventDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

type ReadEventDirectory = (directory: string) => Promise<readonly EventDirectoryEntry[]>;

const readEventDirectory: ReadEventDirectory = (directory) =>
  readdir(directory, { withFileTypes: true });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readPublishedFile = async (filePath: string): Promise<Buffer> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(filePath);
    } catch (error) {
      if (
        attempt + 1 >= PUBLISHED_READ_ATTEMPTS ||
        !TRANSIENT_READ_ERRORS.has(errorCode(error) ?? "")
      ) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
};

const lockRunIdFor = (resourceId: ResourceId): RunId => {
  const bytes = createHash("sha256")
    .update("honeybee-global-unity-resource-lock-v1\0", "utf8")
    .update(resourceId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return RunIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

interface ResourceSnapshot {
  readonly events: readonly UnityGlobalResourceEventV1[];
  readonly requests: ReadonlyMap<string, UnityResourceStatus>;
  readonly active?: UnityResourceLease;
  readonly nextTicket: number;
}

type VisibleResourceStatus = Exclude<UnityResourceStatus, { state: "missing" }>;

type VisibleRequestResult<T> = Readonly<{ found: false }> | Readonly<{ found: true; value: T }>;

const ensureRealDirectoryPath = async (
  rootDirectory: string,
  components: readonly string[],
): Promise<string> => {
  let directory = path.resolve(rootDirectory);
  for (const component of components) {
    const child = path.resolve(directory, component);
    if (path.dirname(child) !== directory) {
      throw new HoneyBeeCoreError("run.indeterminate", "Global resource path escaped its root.");
    }
    try {
      await mkdir(child);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Global resource path could not be prepared safely.",
        );
      }
    }
    let entry;
    try {
      entry = await lstat(child);
    } catch {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Global resource path could not be verified.",
      );
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HoneyBeeCoreError(
        "run.indeterminate",
        "Global resource path is not a real directory.",
      );
    }
    directory = child;
  }
  return directory;
};

const ticketFrom = (event: UnityGlobalResourceEventV1): UnityResourceTicket => ({
  resourceId: event.resourceId,
  requestId: event.requestId,
  ownerRunId: event.ownerRunId,
  ticket: event.ticket,
});

const leaseFrom = (
  event: Extract<UnityGlobalResourceEventV1, { type: "resource.acquired" }>,
): UnityResourceLease => ({ ...ticketFrom(event), leaseId: event.leaseId });

const sameTicket = (left: UnityResourceTicket, right: UnityResourceTicket): boolean =>
  left.resourceId === right.resourceId &&
  left.requestId === right.requestId &&
  left.ownerRunId === right.ownerRunId &&
  left.ticket === right.ticket;

const sameLease = (left: UnityResourceLease, right: UnityResourceLease): boolean =>
  sameTicket(left, right) && left.leaseId === right.leaseId;

export class FileUnityResourceCoordinator implements UnityResourceCoordinator {
  readonly #stateRoot: string;
  readonly #locks: FileRunControl;
  readonly #observedSequences = new Map<ResourceId, number>();

  public constructor(
    rootDirectory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly randomId: () => string = randomUUID,
    private readonly readDirectory: ReadEventDirectory = readEventDirectory,
  ) {
    const root = path.resolve(rootDirectory);
    this.#stateRoot = root;
    this.#locks = new FileRunControl(path.join(root, ".unity-resource-locks", "v1"));
  }

  public async enqueue(requestValue: UnityResourceRequest): Promise<UnityResourceTicket> {
    const request: UnityResourceRequest = {
      resourceId: ResourceIdSchema.parse(requestValue.resourceId),
      requestId: EventIdSchema.parse(requestValue.requestId),
      ownerRunId: RunIdSchema.parse(requestValue.ownerRunId),
    };
    return this.#withLock(request.resourceId, async () => {
      const snapshot = await this.#read(request.resourceId);
      const existing = snapshot.requests.get(request.requestId);
      if (existing !== undefined && existing.state !== "missing") {
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
            "Global resource request ID was reused with different ownership.",
          );
        }
        return identity;
      }
      const ticket: UnityResourceTicket = { ...request, ticket: snapshot.nextTicket + 1 };
      await this.#append(request.resourceId, snapshot.events.length + 1, {
        type: "resource.queued",
        ...ticket,
      });
      return ticket;
    });
  }

  public async acquire(
    locatorValue: UnityResourceLocator,
    signal?: AbortSignal,
  ): Promise<UnityResourceLease> {
    const locator = {
      resourceId: ResourceIdSchema.parse(locatorValue.resourceId),
      requestId: EventIdSchema.parse(locatorValue.requestId),
    };
    for (;;) {
      if (signal?.aborted === true) {
        await this.cancel(locator);
        throw new HoneyBeeCoreError("agent.cancelled", "Global resource wait was cancelled.");
      }
      const result = await this.#withVisibleRequest(locator, async (snapshot, current) => {
        if (current.state === "active") {
          throw new HoneyBeeCoreError(
            "resource.acquire-failed",
            "Global resource lease is already active and requires recovery.",
          );
        }
        if (current.state !== "queued") {
          if (current.state === "cancelled") {
            throw new HoneyBeeCoreError("agent.cancelled", "Global resource wait was cancelled.");
          }
          throw new HoneyBeeCoreError(
            "validation.invalid-workflow",
            "Global resource request is not queued.",
          );
        }
        if (signal?.aborted === true) {
          await this.#append(locator.resourceId, snapshot.events.length + 1, {
            type: "resource.cancelled",
            ...current.ticket,
          });
          throw new HoneyBeeCoreError("agent.cancelled", "Global resource wait was cancelled.");
        }
        const first = [...snapshot.requests.values()]
          .filter(
            (status): status is Extract<UnityResourceStatus, { state: "queued" }> =>
              status.state === "queued",
          )
          .map((status) => status.ticket)
          .sort((left, right) => left.ticket - right.ticket)[0];
        if (snapshot.active !== undefined || first?.requestId !== locator.requestId)
          return undefined;
        const acquired = UnityGlobalResourceEventV1Schema.parse({
          schemaVersion: 1,
          eventId: EventIdSchema.parse(this.randomId()),
          sequence: snapshot.events.length + 1,
          timestamp: this.now().toISOString(),
          type: "resource.acquired",
          ...current.ticket,
          leaseId: EventIdSchema.parse(this.randomId()),
        });
        if (acquired.type !== "resource.acquired") {
          throw new HoneyBeeCoreError("run.indeterminate", "Global resource event is invalid.");
        }
        await this.#appendEvent(locator.resourceId, acquired);
        return leaseFrom(acquired);
      });
      if (!result.found) {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "Global resource request is not queued.",
        );
      }
      if (result.value !== undefined) return result.value;
      await delay(ACQUIRE_POLL_MS);
    }
  }

  public async status(locatorValue: UnityResourceLocator): Promise<UnityResourceStatus> {
    const locator = {
      resourceId: ResourceIdSchema.parse(locatorValue.resourceId),
      requestId: EventIdSchema.parse(locatorValue.requestId),
    };
    const result = await this.#withVisibleRequest(locator, (_snapshot, current) => current);
    return result.found ? result.value : { state: "missing" };
  }

  public async cancel(locatorValue: UnityResourceLocator): Promise<void> {
    const locator = {
      resourceId: ResourceIdSchema.parse(locatorValue.resourceId),
      requestId: EventIdSchema.parse(locatorValue.requestId),
    };
    await this.#withVisibleRequest(locator, async (snapshot, current) => {
      if (current.state === "cancelled") return;
      if (current.state === "active") {
        throw new HoneyBeeCoreError(
          "validation.invalid-workflow",
          "An acquired global resource must be released.",
        );
      }
      if (current.state === "released") return;
      await this.#append(locator.resourceId, snapshot.events.length + 1, {
        type: "resource.cancelled",
        ...current.ticket,
      });
    });
  }

  public async release(leaseValue: UnityResourceLease): Promise<void> {
    const lease: UnityResourceLease = {
      resourceId: ResourceIdSchema.parse(leaseValue.resourceId),
      requestId: EventIdSchema.parse(leaseValue.requestId),
      ownerRunId: RunIdSchema.parse(leaseValue.ownerRunId),
      ticket: leaseValue.ticket,
      leaseId: EventIdSchema.parse(leaseValue.leaseId),
    };
    const result = await this.#withVisibleRequest(lease, async (snapshot, current) => {
      if (current.state === "released" && sameLease(current.lease, lease)) return;
      if (current.state !== "active" || !sameLease(current.lease, lease)) {
        throw new HoneyBeeCoreError(
          "resource.release-failed",
          "Global resource lease ownership does not match.",
        );
      }
      await this.#append(lease.resourceId, snapshot.events.length + 1, {
        type: "resource.released",
        ...lease,
      });
    });
    if (!result.found) {
      throw new HoneyBeeCoreError(
        "resource.release-failed",
        "Global resource lease ownership does not match.",
      );
    }
  }

  async #withLock<T>(resourceIdValue: ResourceId, operation: () => Promise<T>): Promise<T> {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await this.#ensureLockState();
        const lease = await this.#locks.acquire(lockRunIdFor(resourceId));
        try {
          return await operation();
        } finally {
          await this.#ensureLockState();
          await lease.release();
        }
      } catch (error) {
        if (errorCode(error) !== "run.already-running" || Date.now() >= deadline) throw error;
        await delay(LOCK_POLL_MS);
      }
    }
  }

  async #withVisibleRequest<T>(
    locatorValue: UnityResourceLocator,
    operation: (snapshot: ResourceSnapshot, current: VisibleResourceStatus) => Promise<T> | T,
  ): Promise<VisibleRequestResult<T>> {
    const locator = {
      resourceId: ResourceIdSchema.parse(locatorValue.resourceId),
      requestId: EventIdSchema.parse(locatorValue.requestId),
    };
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.#withLock(locator.resourceId, async () => {
        const snapshot = await this.#read(locator.resourceId);
        const current = snapshot.requests.get(locator.requestId);
        if (current === undefined || current.state === "missing") {
          return { found: false } as const;
        }
        return { found: true, value: await operation(snapshot, current) } as const;
      });
      if (result.found || attempt + 1 >= PUBLISHED_READ_ATTEMPTS) return result;
      await delay(10 * (attempt + 1));
    }
  }

  async #read(resourceIdValue: ResourceId): Promise<ResourceSnapshot> {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const { eventsDirectory } = await this.#ensureResourceState(resourceId);
    const minimumSequence = this.#observedSequences.get(resourceId) ?? 0;
    let entries: readonly EventDirectoryEntry[];
    for (let attempt = 0; ; attempt += 1) {
      entries = await this.readDirectory(eventsDirectory);
      if (entries.length >= minimumSequence) break;
      if (attempt + 1 >= PUBLISHED_READ_ATTEMPTS) {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Global resource journal visibility regressed.",
        );
      }
      await delay(10 * (attempt + 1));
    }
    const numbered = entries
      .map((entry) => ({
        name: entry.name,
        match: EVENT_NAME.exec(entry.name),
        validFile: entry.isFile() && !entry.isSymbolicLink(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    if (numbered.some((entry) => entry.match === null || !entry.validFile)) {
      throw new HoneyBeeCoreError("run.indeterminate", "Global resource journal is corrupt.");
    }
    const events: UnityGlobalResourceEventV1[] = [];
    for (const [index, entry] of numbered.entries()) {
      if (Number(entry.match?.[1]) !== index + 1) {
        throw new HoneyBeeCoreError("run.indeterminate", "Global resource sequence is corrupt.");
      }
      let raw: string;
      try {
        raw = (await readPublishedFile(path.join(eventsDirectory, entry.name))).toString("utf8");
      } catch {
        throw new HoneyBeeCoreError("run.indeterminate", "Global resource event is unreadable.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new HoneyBeeCoreError("run.indeterminate", "Global resource event is malformed.");
      }
      const event = UnityGlobalResourceEventV1Schema.safeParse(parsed);
      if (
        !event.success ||
        event.data.sequence !== index + 1 ||
        event.data.resourceId !== resourceId
      ) {
        throw new HoneyBeeCoreError("run.indeterminate", "Global resource event is invalid.");
      }
      events.push(event.data);
    }
    this.#observedSequences.set(resourceId, events.length);
    return this.#replay(events);
  }

  #replay(events: readonly UnityGlobalResourceEventV1[]): ResourceSnapshot {
    const requests = new Map<string, UnityResourceStatus>();
    let active: UnityResourceLease | undefined;
    let nextTicket = 0;
    for (const event of events) {
      const current = requests.get(event.requestId);
      if (event.type === "resource.queued") {
        if (current !== undefined || event.ticket !== nextTicket + 1) {
          throw new HoneyBeeCoreError("run.indeterminate", "Global resource queue is corrupt.");
        }
        const ticket = ticketFrom(event);
        requests.set(event.requestId, { state: "queued", ticket });
        nextTicket = event.ticket;
      } else if (event.type === "resource.acquired") {
        if (
          current?.state !== "queued" ||
          active !== undefined ||
          !sameTicket(current.ticket, ticketFrom(event)) ||
          Math.min(
            ...[...requests.values()]
              .filter(
                (status): status is Extract<UnityResourceStatus, { state: "queued" }> =>
                  status.state === "queued",
              )
              .map((status) => status.ticket.ticket),
          ) !== event.ticket
        ) {
          throw new HoneyBeeCoreError(
            "run.indeterminate",
            "Global resource acquisition is corrupt.",
          );
        }
        active = leaseFrom(event);
        requests.set(event.requestId, { state: "active", lease: active });
      } else if (event.type === "resource.cancelled") {
        if (current?.state !== "queued" || !sameTicket(current.ticket, ticketFrom(event))) {
          throw new HoneyBeeCoreError(
            "run.indeterminate",
            "Global resource cancellation is corrupt.",
          );
        }
        requests.set(event.requestId, { state: "cancelled", ticket: current.ticket });
      } else {
        const released = { ...ticketFrom(event), leaseId: event.leaseId };
        if (
          current?.state !== "active" ||
          active === undefined ||
          !sameLease(current.lease, released) ||
          !sameLease(active, released)
        ) {
          throw new HoneyBeeCoreError("run.indeterminate", "Global resource release is corrupt.");
        }
        requests.set(event.requestId, { state: "released", lease: released });
        active = undefined;
      }
    }
    return { events, requests, ...(active === undefined ? {} : { active }), nextTicket };
  }

  async #append(
    resourceId: ResourceId,
    sequence: number,
    value: Readonly<
      | ({ type: "resource.queued" | "resource.cancelled" } & UnityResourceTicket)
      | ({ type: "resource.released" } & UnityResourceLease)
    >,
  ): Promise<void> {
    const event = UnityGlobalResourceEventV1Schema.parse({
      schemaVersion: 1,
      eventId: EventIdSchema.parse(this.randomId()),
      sequence,
      timestamp: this.now().toISOString(),
      ...value,
    });
    await this.#appendEvent(resourceId, event);
  }

  async #appendEvent(
    resourceIdValue: ResourceId,
    event: UnityGlobalResourceEventV1,
  ): Promise<void> {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const { eventsDirectory, temporaryDirectory } = await this.#ensureResourceState(resourceId);
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
    const finalPath = path.join(
      eventsDirectory,
      `${String(event.sequence).padStart(20, "0")}.json`,
    );
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx");
      temporaryExists = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, finalPath);
      if (!Buffer.from(await readPublishedFile(finalPath)).equals(bytes)) {
        throw new HoneyBeeCoreError("run.indeterminate", "Global resource publish was corrupted.");
      }
      this.#observedSequences.set(
        resourceId,
        Math.max(this.#observedSequences.get(resourceId) ?? 0, event.sequence),
      );
    } catch (error) {
      if (error instanceof HoneyBeeCoreError) throw error;
      if (errorCode(error) === "EEXIST") {
        throw new HoneyBeeCoreError(
          "run.indeterminate",
          "Global resource sequence already exists.",
        );
      }
      throw new HoneyBeeCoreError("journal.write-failed", "Global resource event publish failed.");
    } finally {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #ensureResourceState(resourceIdValue: ResourceId): Promise<
    Readonly<{
      eventsDirectory: string;
      temporaryDirectory: string;
    }>
  > {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const components = [".unity-resources", "v1", resourceId] as const;
    const eventsDirectory = await ensureRealDirectoryPath(this.#stateRoot, [
      ...components,
      "events",
    ]);
    const temporaryDirectory = await ensureRealDirectoryPath(this.#stateRoot, [
      ...components,
      "tmp",
    ]);
    return { eventsDirectory, temporaryDirectory };
  }

  async #ensureLockState(): Promise<void> {
    for (const leaf of ["active", "candidates", "stale", "released"] as const) {
      await ensureRealDirectoryPath(this.#stateRoot, [
        ".unity-resource-locks",
        "v1",
        ".leases",
        leaf,
      ]);
    }
  }
}
