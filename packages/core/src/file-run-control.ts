import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ControlRequestSchema,
  EventIdSchema,
  RunIdSchema,
  type ControlRequest,
  type RunId,
} from "@honeybee/orchestration-contracts";

import { HoneyBeeCoreError } from "./errors.js";
import type { RunLease, RunLeaseManager } from "./types.js";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

const execFileAsync = promisify(execFile);

interface ProcessObservation {
  readonly status: "alive" | "missing";
  readonly identity?: string;
}

const readProcessIdentity = async (pid: number): Promise<string> => {
  if (process.platform === "win32") {
    const command =
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      "[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    const ticks = stdout.trim();
    if (!/^\d+$/u.test(ticks)) throw new Error("Invalid Windows process creation time.");
    return `win32:${ticks}`;
  }
  if (process.platform === "linux") {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    const fields =
      commandEnd < 0
        ? []
        : stat
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/u);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
      throw new Error("Invalid Linux process start time.");
    }
    return `linux:${bootId.trim()}:${startTicks}`;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const startedAt = stdout.trim().replace(/\s+/gu, " ");
  if (startedAt.length === 0) throw new Error("Missing process creation time.");
  return `${process.platform}:${startedAt}`;
};

const observeProcess = async (pid: number): Promise<ProcessObservation> => {
  if (!processExists(pid)) return { status: "missing" };
  try {
    return { status: "alive", identity: await readProcessIdentity(pid) };
  } catch {
    return processExists(pid) ? { status: "alive" } : { status: "missing" };
  }
};

let currentProcessObservation: Promise<ProcessObservation> | undefined;
const observeLeaseProcess = (pid: number): Promise<ProcessObservation> => {
  if (pid !== process.pid) return observeProcess(pid);
  currentProcessObservation ??= observeProcess(pid);
  return currentProcessObservation;
};

interface LeaseObservation {
  readonly identity: string;
  readonly leaseId?: string;
  readonly pid?: number;
  readonly processIdentity?: string;
}

interface LeasePaths {
  readonly active: string;
  readonly candidate: string;
  readonly stale: string;
  readonly released: string;
}

const contentionError = (error: unknown): boolean =>
  ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOENT"].includes(errorCode(error) ?? "");

export class FileRunControl implements RunLeaseManager {
  readonly #root: string;

  public constructor(rootDirectory: string) {
    this.#root = path.resolve(rootDirectory);
  }

  public async acquire(runId: RunId): Promise<RunLease> {
    const validated = RunIdSchema.parse(runId);
    const ownerProcess = await observeLeaseProcess(process.pid);
    if (ownerProcess.status !== "alive" || ownerProcess.identity === undefined) {
      throw new HoneyBeeCoreError(
        "run.lease-failed",
        "Could not establish the executor process identity.",
      );
    }
    const leaseId = randomUUID();
    const paths = await this.#leasePaths(validated, leaseId);
    await mkdir(paths.candidate);
    const ownerPath = path.join(paths.candidate, "owner.json");
    const owner = await open(ownerPath, "wx");
    try {
      await owner.writeFile(
        `${JSON.stringify({
          schemaVersion: 2,
          leaseId,
          pid: process.pid,
          processIdentity: ownerProcess.identity,
        })}\n`,
      );
      await owner.sync();
    } finally {
      await owner.close();
    }

    let acquired = false;
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          await rename(paths.candidate, paths.active);
          acquired = true;
          let released = false;
          return {
            release: async () => {
              if (released) return;
              released = true;
              const current = await this.#readLease(paths.active);
              if (current?.leaseId !== leaseId) return;
              try {
                await rename(paths.active, paths.released);
              } catch (error) {
                if (errorCode(error) === "ENOENT") return;
                throw new HoneyBeeCoreError(
                  "run.lease-failed",
                  `Could not release Run ${validated}.`,
                );
              }
              await rm(paths.released, { recursive: true, force: true });
            },
          };
        } catch (error) {
          if (!contentionError(error)) {
            throw new HoneyBeeCoreError("run.lease-failed", `Could not acquire Run ${validated}.`);
          }
        }

        const current = await this.#readLease(paths.active);
        if (current === undefined) continue;
        if (await this.#leaseIsActive(current)) {
          throw new HoneyBeeCoreError(
            "run.already-running",
            `Run ${validated} already has an executor.`,
          );
        }
        const stalePath = path.join(paths.stale, `${validated}.${current.identity}`);
        try {
          await rename(paths.active, stalePath);
        } catch (error) {
          if (!contentionError(error)) {
            throw new HoneyBeeCoreError(
              "run.lease-failed",
              `Could not recover the stale lease for Run ${validated}.`,
            );
          }
        }
      }
      throw new HoneyBeeCoreError("run.lease-failed", `Could not acquire Run ${validated}.`);
    } finally {
      if (!acquired) await rm(paths.candidate, { recursive: true, force: true });
    }
  }

  public async submit(request: ControlRequest): Promise<void> {
    const parsed = ControlRequestSchema.parse(request);
    const inbox = await this.#requireInbox(parsed.runId);
    const requestPath = path.join(inbox, `${EventIdSchema.parse(parsed.requestId)}.json`);
    const temporaryPath = path.join(inbox, `.${parsed.requestId}.${randomUUID()}.tmp`);
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx");
      temporaryExists = true;
      try {
        await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, requestPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return;
      throw new HoneyBeeCoreError("control.write-failed", "Control request could not be stored.");
    } finally {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  public async pending(runId: RunId): Promise<readonly ControlRequest[]> {
    const validated = RunIdSchema.parse(runId);
    const inbox = path.join(this.#runDirectory(validated), "control", "inbox");
    let names: string[];
    try {
      names = (await readdir(inbox)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new HoneyBeeCoreError("control.read-failed", "Control inbox could not be read.");
    }
    const requests: ControlRequest[] = [];
    for (const name of names) {
      try {
        const value = JSON.parse(await readFile(path.join(inbox, name), "utf8")) as unknown;
        const request = ControlRequestSchema.parse(value);
        if (request.runId !== validated || `${request.requestId}.json` !== name) throw new Error();
        requests.push(request);
      } catch {
        throw new HoneyBeeCoreError("control.read-failed", "Control inbox is malformed.");
      }
    }
    return requests;
  }

  public async acknowledge(request: ControlRequest): Promise<void> {
    const parsed = ControlRequestSchema.parse(request);
    const requestPath = path.join(
      this.#runDirectory(parsed.runId),
      "control",
      "inbox",
      `${parsed.requestId}.json`,
    );
    await unlink(requestPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        throw new HoneyBeeCoreError(
          "control.write-failed",
          "Control request could not be acknowledged.",
        );
      }
    });
  }

  public async executorPresent(runId: RunId): Promise<boolean> {
    const validated = RunIdSchema.parse(runId);
    const paths = await this.#leasePaths(validated, randomUUID());
    const lease = await this.#readLease(paths.active);
    return lease === undefined ? false : this.#leaseIsActive(lease);
  }

  #runDirectory(runId: RunId): string {
    const validated = RunIdSchema.parse(runId);
    const target = path.resolve(this.#root, validated);
    if (path.dirname(target) !== this.#root) {
      throw new HoneyBeeCoreError("run.invalid-path", "Run path escaped the run repository.");
    }
    return target;
  }

  async #requireInbox(runId: RunId): Promise<string> {
    const inbox = path.join(this.#runDirectory(runId), "control", "inbox");
    try {
      const entry = await lstat(inbox);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("not a real directory");
      return inbox;
    } catch {
      throw new HoneyBeeCoreError("run.not-found", `Run ${runId} does not exist.`);
    }
  }

  async #leasePaths(runId: RunId, leaseId: string): Promise<LeasePaths> {
    const leaseRoot = path.join(this.#root, ".leases");
    const activeRoot = path.join(leaseRoot, "active");
    const candidateRoot = path.join(leaseRoot, "candidates");
    const staleRoot = path.join(leaseRoot, "stale");
    const releasedRoot = path.join(leaseRoot, "released");
    await Promise.all(
      [activeRoot, candidateRoot, staleRoot, releasedRoot].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    return {
      active: path.join(activeRoot, runId),
      candidate: path.join(candidateRoot, leaseId),
      stale: staleRoot,
      released: path.join(releasedRoot, `${runId}.${leaseId}`),
    };
  }

  async #readLease(activePath: string): Promise<LeaseObservation | undefined> {
    try {
      const raw = await readFile(path.join(activePath, "owner.json"), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const leaseId =
          "leaseId" in parsed && typeof parsed.leaseId === "string" ? parsed.leaseId : undefined;
        const pid =
          "pid" in parsed && Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
            ? (parsed.pid as number)
            : undefined;
        const processIdentity =
          "processIdentity" in parsed &&
          typeof parsed.processIdentity === "string" &&
          parsed.processIdentity.length > 0 &&
          parsed.processIdentity.length <= 512
            ? parsed.processIdentity
            : undefined;
        const validatedLeaseId = EventIdSchema.safeParse(leaseId);
        if (validatedLeaseId.success) {
          return {
            identity: validatedLeaseId.data,
            leaseId: validatedLeaseId.data,
            ...(pid === undefined ? {} : { pid }),
            ...(processIdentity === undefined ? {} : { processIdentity }),
          };
        }
      }
      return { identity: createHash("sha256").update(raw).digest("hex") };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new HoneyBeeCoreError("run.lease-failed", "Could not inspect the executor lease.");
      }
      try {
        const entry = await lstat(activePath);
        return entry.isDirectory() ? { identity: "missing-owner" } : undefined;
      } catch (entryError) {
        if (errorCode(entryError) === "ENOENT") return undefined;
        throw new HoneyBeeCoreError("run.lease-failed", "Could not inspect the executor lease.");
      }
    }
  }

  async #leaseIsActive(lease: LeaseObservation): Promise<boolean> {
    if (lease.pid === undefined) return false;
    const process = await observeLeaseProcess(lease.pid);
    if (process.status === "missing") return false;
    if (lease.processIdentity === undefined || process.identity === undefined) return true;
    return lease.processIdentity === process.identity;
  }
}
