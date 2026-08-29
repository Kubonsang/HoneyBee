import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  NativeAgentAbandonedReceiptV1Schema,
  NativeAgentActivationReceiptV1Schema,
  NativeAgentCancelRequestV1Schema,
  NativeAgentExitReceiptV1Schema,
  NativeAgentHostActivationV1Schema,
  NativeAgentHostLaunchIntentV1Schema,
  NativeAgentHostReceiptV1Schema,
  NativeAgentProcessReceiptV1Schema,
  EventIdSchema,
  type NativeAgentActivationReceiptV1,
  type NativeAgentExitReceiptV1,
  type NativeAgentHostActivationV1,
  type NativeAgentHostLaunchIntentV1,
  type NativeAgentHostPhaseV1,
  type NativeAgentHostReceiptV1,
  type NativeAgentProcessReceiptV1,
} from "@honeybee/orchestration-contracts";
import { HoneyBeeCoreError } from "@honeybee/core";
import type { z } from "zod";

import {
  publishImmutableJson,
  readRecoveredImmutableFile,
  UnsafeImmutablePublicationError,
} from "./immutable-publication.js";
import { SystemUnityProcessControl, type UnityProcessControl } from "./process-control.js";

const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const TEMPORARY_RECEIPT = /^\.[0-9a-f-]{36}\.tmp$/iu;
const PRIORITY_ORDER = { interactive: 0, validation: 1, background: 2 } as const;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
};

const digestFile = async (filePath: string): Promise<string> => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return `sha256:${digest.digest("hex")}`;
};

const internalEnvironment = (): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "PATH", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const ensureRealLaunchDirectory = async (stateRoot: string, launchId: string): Promise<string> => {
  launchId = EventIdSchema.parse(launchId);
  const root = path.resolve(stateRoot);
  await mkdir(root, { recursive: true });
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new HoneyBeeCoreError(
      "native-agent-host.path-invalid",
      "State root is not a real directory.",
    );
  }
  let candidate = root;
  for (const component of [".native-agent-host", "v1", "launches", launchId]) {
    candidate = path.join(candidate, component);
    await mkdir(candidate).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HoneyBeeCoreError(
        "native-agent-host.path-invalid",
        "Native Host state path contains a filesystem link.",
      );
    }
  }
  const [physicalRoot, physicalCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  const relative = path.relative(physicalRoot, physicalCandidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new HoneyBeeCoreError(
      "native-agent-host.path-invalid",
      "Native Host state escaped its configured root.",
    );
  }
  return candidate;
};

const readReceipt = async <T>(filePath: string, schema: z.ZodType<T>): Promise<T | undefined> => {
  let bytes: Buffer;
  try {
    ({ bytes } = await readRecoveredImmutableFile(
      filePath,
      (candidate) => TEMPORARY_RECEIPT.test(candidate),
      MAXIMUM_RECEIPT_BYTES,
    ));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof UnsafeImmutablePublicationError) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Native Host receipt has an unrecognized hard link.",
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new HoneyBeeCoreError(
      "native-agent-host.receipt-invalid",
      "Native Host receipt is malformed.",
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HoneyBeeCoreError(
      "native-agent-host.receipt-invalid",
      "Native Host receipt violates its public contract.",
    );
  }
  return result.data;
};

const assertReceiptIdentity = (
  receipt: Readonly<{ launchId: string; nonce: string }>,
  intent: NativeAgentHostLaunchIntentV1,
): void => {
  if (receipt.launchId !== intent.launchId || receipt.nonce !== intent.nonce) {
    throw new HoneyBeeCoreError(
      "native-agent-host.receipt-invalid",
      "Native Host receipt does not match its launch identity.",
    );
  }
};

interface HostWireEvent {
  readonly schemaVersion: 1;
  readonly type:
    | "host-registered"
    | "process-registered"
    | "provider-resumed"
    | "activated"
    | "exited"
    | "failed";
  readonly launchId?: string;
  readonly receiptPath?: string;
  readonly errorCode?: string;
}

interface HostEventWaiter {
  readonly expected: HostWireEvent["type"];
  readonly resolve: (value: HostWireEvent) => void;
  readonly reject: (error: unknown) => void;
  timeout?: NodeJS.Timeout;
}

class HostEventStream {
  readonly #events: HostWireEvent[] = [];
  readonly #waiters: HostEventWaiter[] = [];
  readonly #closed: Promise<void>;
  #ended: unknown;
  #sawExit = false;

  public constructor(child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.fail(new Error("Native Host emitted malformed JSON."));
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("schemaVersion" in parsed) ||
        parsed.schemaVersion !== 1 ||
        !("type" in parsed) ||
        typeof parsed.type !== "string"
      ) {
        this.fail(new Error("Native Host emitted an invalid event."));
        return;
      }
      const event = parsed as HostWireEvent;
      if (event.type === "failed") {
        this.fail(
          new HoneyBeeCoreError(
            "native-agent-host.failed",
            "Native Agent Host reported a typed failure.",
            undefined,
            event.errorCode === undefined ? undefined : { hostErrorCode: event.errorCode },
          ),
        );
        return;
      }
      if (event.type === "exited") this.#sawExit = true;
      const waiter = this.#waiters[0];
      if (waiter !== undefined && waiter.expected !== event.type) {
        this.fail(new Error(`Expected ${waiter.expected}, received ${event.type}.`));
      } else if (waiter !== undefined) {
        this.#waiters.shift();
        if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
        waiter.resolve(event);
      } else {
        this.#events.push(event);
      }
    });
    this.#closed = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        this.fail(error);
        reject(error);
      });
      child.once("close", (code) => {
        if (this.#sawExit && code === 0) {
          resolve();
          return;
        }
        const error = new HoneyBeeCoreError(
          "native-agent-host.failed",
          "Native Agent Host supervisor closed before completing its protocol.",
        );
        this.fail(error);
        reject(error);
      });
    });
    void this.#closed.catch(() => undefined);
  }

  public wait(expected: HostWireEvent["type"], timeoutMs?: number): Promise<HostWireEvent> {
    const existing = this.#events[0];
    if (existing !== undefined) {
      if (existing.type !== expected) {
        return Promise.reject(new Error(`Expected ${expected}, received ${existing.type}.`));
      }
      this.#events.shift();
      return Promise.resolve(existing);
    }
    if (this.#ended !== undefined) return Promise.reject(this.#ended);
    return new Promise((resolve, reject) => {
      const waiter: HostEventWaiter = { expected, resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          const index = this.#waiters.findIndex((candidate) => candidate.resolve === resolve);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(
            new HoneyBeeCoreError(
              "native-agent-host.timeout",
              `Native Agent Host did not publish ${expected} in time.`,
            ),
          );
        }, timeoutMs);
      }
      this.#waiters.push(waiter);
    });
  }

  public async waitForClose(): Promise<void> {
    await this.#closed;
  }

  private fail(error: unknown): void {
    if (this.#ended !== undefined) return;
    this.#ended = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

export interface NativeAgentHostLifecycle {
  onHostRegistered(receipt: NativeAgentHostReceiptV1): Promise<void>;
  onProcessRegistered(receipt: NativeAgentProcessReceiptV1): Promise<void>;
  onActivated(receipt: NativeAgentActivationReceiptV1): Promise<void>;
}

export interface NativeAgentHostHandle {
  readonly intent: NativeAgentHostLaunchIntentV1;
  readonly host: NativeAgentHostReceiptV1;
  readonly process: NativeAgentProcessReceiptV1;
  readonly activation: NativeAgentActivationReceiptV1;
  readonly completion: Promise<NativeAgentExitReceiptV1>;
  cancel(): Promise<string>;
}

export interface NativeAgentLaunchInspection {
  readonly intent: NativeAgentHostLaunchIntentV1;
  readonly phase: NativeAgentHostPhaseV1;
  readonly occupied: boolean;
  readonly reason?: string;
}

export class SystemNativeAgentHost {
  public constructor(
    private readonly stateRoot: string,
    private readonly processes: UnityProcessControl = new SystemUnityProcessControl(),
  ) {}

  public launchDirectory(launchId: string): Promise<string> {
    return ensureRealLaunchDirectory(this.stateRoot, launchId);
  }

  public async launch(
    intentValue: NativeAgentHostLaunchIntentV1,
    activationValue: NativeAgentHostActivationV1,
    lifecycle: NativeAgentHostLifecycle,
  ): Promise<NativeAgentHostHandle> {
    if (process.platform !== "win32") {
      throw new HoneyBeeCoreError(
        "native-agent-host.unsupported-platform",
        "Native Agent Host v1 requires Windows.",
      );
    }
    const intent = NativeAgentHostLaunchIntentV1Schema.parse(intentValue);
    if (
      !path.isAbsolute(activationValue.command.command) ||
      !samePath(path.resolve(activationValue.command.command), activationValue.command.command)
    ) {
      throw new HoneyBeeCoreError(
        "native-agent-host.provider-invalid",
        "Provider executable path must be canonical and absolute.",
      );
    }
    const activation = NativeAgentHostActivationV1Schema.parse({
      ...activationValue,
      command: {
        ...activationValue.command,
        env: { ...process.env, ...activationValue.command.env },
      },
    });
    const directory = await this.launchDirectory(intent.launchId);
    if (!samePath(directory, intent.receiptDirectory)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.path-invalid",
        "Launch receipt directory does not match the state-root layout.",
      );
    }
    if (!samePath(path.resolve(intent.hostExecutablePath), intent.hostExecutablePath)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.binary-invalid",
        "Native Host executable path must be canonical and absolute.",
      );
    }
    if ((await digestFile(intent.hostExecutablePath)) !== intent.hostExecutableDigest) {
      throw new HoneyBeeCoreError(
        "native-agent-host.binary-invalid",
        "Native Host executable digest does not match its pin.",
      );
    }
    if ((await digestFile(activation.command.command)) !== activation.executableDigest) {
      throw new HoneyBeeCoreError(
        "native-agent-host.provider-invalid",
        "Provider executable digest does not match its pin.",
      );
    }
    const intentPath = path.join(directory, "intent.json");
    await publishImmutableJson(intentPath, intent);
    // Revalidate immediately before every invocation. The Host independently
    // locks and hashes itself and the provider again before CreateProcess.
    if ((await digestFile(intent.hostExecutablePath)) !== intent.hostExecutableDigest) {
      throw new HoneyBeeCoreError(
        "native-agent-host.binary-invalid",
        "Native Host executable changed before invocation.",
      );
    }
    const child = spawn(intent.hostExecutablePath, ["supervise", "--intent", intentPath], {
      cwd: directory,
      env: internalEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = new HostEventStream(child);
    child.stderr.resume();
    let providerMayBeActive = false;
    try {
      const hostEvent = await events.wait("host-registered", intent.registrationTimeoutMs);
      const host = await this.#readHostReceipt(intent, hostEvent.receiptPath);
      await lifecycle.onHostRegistered(host);
      await this.#writeMessage(child, { type: "activation", activation });
      const processEvent = await events.wait("process-registered", intent.activationTimeoutMs);
      const target = await this.#readProcessReceipt(intent, processEvent.receiptPath);
      await lifecycle.onProcessRegistered(target);
      await this.#writeMessage(child, { type: "activate" });
      providerMayBeActive = true;
      await events.wait("provider-resumed", intent.activationTimeoutMs);
      const activationEvent = await events.wait("activated", intent.activationTimeoutMs);
      const activationReceipt = await this.#readActivationReceipt(
        intent,
        target,
        activationEvent.receiptPath,
      );
      await lifecycle.onActivated(activationReceipt);
      const completion = this.#completion(intent, events);
      let cancelRequestId: string | undefined;
      return {
        intent,
        host,
        process: target,
        activation: activationReceipt,
        completion,
        cancel: async () => (cancelRequestId ??= await this.#requestCancel(directory, intent)),
      };
    } catch (error) {
      if (providerMayBeActive) {
        try {
          await this.#requestCancel(directory, intent);
          await this.#awaitExitReceipt(intent);
        } catch (cleanupError) {
          throw new HoneyBeeCoreError(
            "native-agent-host.failed",
            "Native Host activation failed and durable cleanup remains unresolved.",
            undefined,
            { cleanupErrorCode: errorCode(cleanupError) ?? "unknown" },
          );
        }
      } else {
        child.stdin.destroy();
        child.kill();
      }
      throw error;
    }
  }

  async #awaitExitReceipt(
    intent: NativeAgentHostLaunchIntentV1,
  ): Promise<NativeAgentExitReceiptV1> {
    const expected = path.join(intent.receiptDirectory, "exit-receipt.json");
    const deadline = Date.now() + intent.shutdownTimeoutMs;
    for (;;) {
      const receipt = await readReceipt(expected, NativeAgentExitReceiptV1Schema);
      if (receipt !== undefined) {
        assertReceiptIdentity(receipt, intent);
        return receipt;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HoneyBeeCoreError(
          "native-agent-host.timeout",
          "Native Host did not publish its durable exit receipt during cleanup.",
        );
      }
      await delay(Math.min(50, remaining));
    }
  }

  async #writeMessage(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  async #requestCancel(directory: string, intent: NativeAgentHostLaunchIntentV1): Promise<string> {
    const requestId = randomUUID();
    const request = NativeAgentCancelRequestV1Schema.parse({
      schemaVersion: 1,
      requestId,
      launchId: intent.launchId,
      nonce: intent.nonce,
      requestedAt: new Date().toISOString(),
    });
    await publishImmutableJson(path.join(directory, "cancel-request.json"), request);
    return requestId;
  }

  async #completion(
    intent: NativeAgentHostLaunchIntentV1,
    events: HostEventStream,
  ): Promise<NativeAgentExitReceiptV1> {
    const event = await events.wait("exited");
    const expected = path.join(intent.receiptDirectory, "exit-receipt.json");
    if (event.receiptPath !== undefined && !samePath(event.receiptPath, expected)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Exit receipt path changed.",
      );
    }
    const receipt = await readReceipt(expected, NativeAgentExitReceiptV1Schema);
    if (receipt === undefined) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Native Host exit event has no receipt.",
      );
    }
    assertReceiptIdentity(receipt, intent);
    await events.waitForClose();
    return receipt;
  }

  async #readHostReceipt(
    intent: NativeAgentHostLaunchIntentV1,
    eventPath?: string,
  ): Promise<NativeAgentHostReceiptV1> {
    const expected = path.join(intent.receiptDirectory, "host-receipt.json");
    if (eventPath !== undefined && !samePath(eventPath, expected)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Host receipt path changed.",
      );
    }
    const receipt = await readReceipt(expected, NativeAgentHostReceiptV1Schema);
    if (receipt === undefined) throw new Error("Host receipt is missing.");
    assertReceiptIdentity(receipt, intent);
    const identity = await this.processes.captureIdentity(receipt.hostPid);
    if (identity !== receipt.processIdentity) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Host process identity changed before registration.",
      );
    }
    return receipt;
  }

  async #readProcessReceipt(
    intent: NativeAgentHostLaunchIntentV1,
    eventPath?: string,
  ): Promise<NativeAgentProcessReceiptV1> {
    const expected = path.join(intent.receiptDirectory, "process-receipt.json");
    if (eventPath !== undefined && !samePath(eventPath, expected)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Provider receipt path changed.",
      );
    }
    const receipt = await readReceipt(expected, NativeAgentProcessReceiptV1Schema);
    if (receipt === undefined) throw new Error("Provider receipt is missing.");
    assertReceiptIdentity(receipt, intent);
    const identity = await this.processes.captureIdentity(receipt.targetPid);
    if (identity !== receipt.processIdentity) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Provider process identity changed before activation.",
      );
    }
    return receipt;
  }

  async #readActivationReceipt(
    intent: NativeAgentHostLaunchIntentV1,
    target: NativeAgentProcessReceiptV1,
    eventPath?: string,
  ): Promise<NativeAgentActivationReceiptV1> {
    const expected = path.join(intent.receiptDirectory, "activation-receipt.json");
    if (eventPath !== undefined && !samePath(eventPath, expected)) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Activation receipt path changed.",
      );
    }
    const receipt = await readReceipt(expected, NativeAgentActivationReceiptV1Schema);
    if (receipt === undefined) throw new Error("Activation receipt is missing.");
    assertReceiptIdentity(receipt, intent);
    if (
      receipt.targetPid !== target.targetPid ||
      receipt.processIdentity !== target.processIdentity
    ) {
      throw new HoneyBeeCoreError(
        "native-agent-host.receipt-invalid",
        "Activation receipt does not match the registered provider.",
      );
    }
    return receipt;
  }

  public async inspect(
    intentValue: NativeAgentHostLaunchIntentV1,
  ): Promise<NativeAgentLaunchInspection> {
    const intent = NativeAgentHostLaunchIntentV1Schema.parse(intentValue);
    const directory = intent.receiptDirectory;
    const [abandoned, exit, host, target, activation] = await Promise.all([
      readReceipt(
        path.join(directory, "abandoned-receipt.json"),
        NativeAgentAbandonedReceiptV1Schema,
      ),
      readReceipt(path.join(directory, "exit-receipt.json"), NativeAgentExitReceiptV1Schema),
      readReceipt(path.join(directory, "host-receipt.json"), NativeAgentHostReceiptV1Schema),
      readReceipt(path.join(directory, "process-receipt.json"), NativeAgentProcessReceiptV1Schema),
      readReceipt(
        path.join(directory, "activation-receipt.json"),
        NativeAgentActivationReceiptV1Schema,
      ),
    ]);
    for (const receipt of [abandoned, exit, host, target, activation]) {
      if (receipt !== undefined) assertReceiptIdentity(receipt, intent);
    }
    if (exit !== undefined) return { intent, phase: "exited", occupied: false };
    if (abandoned !== undefined) {
      return { intent, phase: "abandoned-before-registration", occupied: false };
    }
    if (host === undefined) {
      const expiresAt = Date.parse(intent.createdAt) + intent.registrationTimeoutMs;
      if (Date.now() <= expiresAt) return { intent, phase: "intended", occupied: true };
      const receipt = NativeAgentAbandonedReceiptV1Schema.parse({
        schemaVersion: 1,
        launchId: intent.launchId,
        nonce: intent.nonce,
        reason: "registration-timeout",
        reconciledAt: new Date().toISOString(),
      });
      await publishImmutableJson(path.join(directory, "abandoned-receipt.json"), receipt);
      return { intent, phase: "abandoned-before-registration", occupied: false };
    }
    const observedHost = await this.processes.captureIdentity(host.hostPid).catch(() => undefined);
    if (observedHost !== host.processIdentity) {
      if (target === undefined) {
        const receipt = NativeAgentAbandonedReceiptV1Schema.parse({
          schemaVersion: 1,
          launchId: intent.launchId,
          nonce: intent.nonce,
          reason: "host-missing-before-process",
          reconciledAt: new Date().toISOString(),
        });
        await publishImmutableJson(path.join(directory, "abandoned-receipt.json"), receipt);
      }
      return {
        intent,
        phase: target === undefined ? "abandoned-before-registration" : "indeterminate",
        occupied: false,
        reason: "host-missing; Host-only KILL_ON_JOB_CLOSE implies descendant drain",
      };
    }
    if (activation !== undefined) return { intent, phase: "active", occupied: true };
    if (target !== undefined) return { intent, phase: "process-registered", occupied: true };
    return { intent, phase: "host-registered", occupied: true };
  }
}

export interface NativeAgentAdmissionCandidate {
  readonly id: string;
  readonly priority: NativeAgentHostLaunchIntentV1["priority"];
  readonly createdAt: string;
}

export class NativeAgentCapacityIndex {
  public constructor(
    private readonly host: SystemNativeAgentHost,
    private readonly stateRoot: string,
    public readonly capacity = 4,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new TypeError("capacity must be positive");
  }

  public async reconstruct(): Promise<readonly NativeAgentLaunchInspection[]> {
    const launches = path.join(
      path.resolve(this.stateRoot),
      ".native-agent-host",
      "v1",
      "launches",
    );
    let entries;
    try {
      entries = await readdir(launches, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const inspections: NativeAgentLaunchInspection[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const intent = await readReceipt(
        path.join(launches, entry.name, "intent.json"),
        NativeAgentHostLaunchIntentV1Schema,
      );
      if (intent !== undefined) inspections.push(await this.host.inspect(intent));
    }
    return inspections;
  }

  public async select(
    candidates: readonly NativeAgentAdmissionCandidate[],
  ): Promise<readonly NativeAgentAdmissionCandidate[]> {
    const occupied = (await this.reconstruct()).filter((entry) => entry.occupied).length;
    const available = Math.max(0, this.capacity - occupied);
    return [...candidates]
      .sort(
        (left, right) =>
          PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, available);
  }
}

export const newNativeAgentLaunchIdentity = (): Readonly<{
  launchId: string;
  nonce: string;
}> => ({ launchId: randomUUID(), nonce: randomBytes(32).toString("hex") });

export const waitForNativeHostReconciliation = async (
  host: SystemNativeAgentHost,
  intent: NativeAgentHostLaunchIntentV1,
  timeoutMs: number,
): Promise<NativeAgentLaunchInspection> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inspection = await host.inspect(intent);
    if (!inspection.occupied) return inspection;
    if (Date.now() >= deadline) return inspection;
    await delay(Math.min(100, deadline - Date.now()));
  }
};
