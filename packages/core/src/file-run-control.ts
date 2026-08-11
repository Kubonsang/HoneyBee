import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

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

export class FileRunControl implements RunLeaseManager {
  readonly #root: string;

  public constructor(rootDirectory: string) {
    this.#root = path.resolve(rootDirectory);
  }

  public async acquire(runId: RunId): Promise<RunLease> {
    const directory = this.#runDirectory(runId);
    const lockPath = path.join(directory, "executor.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await handle.close();
            await unlink(lockPath).catch(() => undefined);
          },
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new HoneyBeeCoreError("run.lease-failed", `Could not acquire Run ${runId}.`);
        }
        const pid = await this.#readPid(lockPath);
        if (pid !== undefined && processExists(pid)) {
          throw new HoneyBeeCoreError(
            "run.already-running",
            `Run ${runId} already has an executor.`,
          );
        }
        await unlink(lockPath).catch(() => undefined);
      }
    }
    throw new HoneyBeeCoreError("run.lease-failed", `Could not acquire Run ${runId}.`);
  }

  public async submit(request: ControlRequest): Promise<void> {
    const parsed = ControlRequestSchema.parse(request);
    const inbox = path.join(this.#runDirectory(parsed.runId), "control", "inbox");
    await mkdir(inbox, { recursive: true });
    const requestPath = path.join(inbox, `${EventIdSchema.parse(parsed.requestId)}.json`);
    try {
      const handle = await open(requestPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) === "EEXIST") return;
      throw new HoneyBeeCoreError("control.write-failed", "Control request could not be stored.");
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
    const pid = await this.#readPid(path.join(this.#runDirectory(runId), "executor.lock"));
    return pid !== undefined && processExists(pid);
  }

  #runDirectory(runId: RunId): string {
    const validated = RunIdSchema.parse(runId);
    const target = path.resolve(this.#root, validated);
    if (path.dirname(target) !== this.#root) {
      throw new HoneyBeeCoreError("run.invalid-path", "Run path escaped the run repository.");
    }
    return target;
  }

  async #readPid(lockPath: string): Promise<number | undefined> {
    try {
      const value = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      return undefined;
    }
  }
}
