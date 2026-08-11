import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EventIdSchema, RunIdSchema } from "@honeybee/orchestration-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { FileRunControl } from "./file-run-control.js";
import { FileRunRepository } from "./file-storage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FileRunControl", () => {
  it("allows one executor and durably acknowledges typed control requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const controls = new FileRunControl(root);
    const lease = await controls.acquire(runId);
    expect(await controls.executorPresent(runId)).toBe(true);
    await expect(controls.acquire(runId)).rejects.toMatchObject({ code: "run.already-running" });

    const request = {
      requestId: EventIdSchema.parse(randomUUID()),
      runId,
      action: "pause" as const,
      timestamp: new Date().toISOString(),
    };
    await controls.submit(request);
    await controls.submit(request);
    expect(await controls.pending(runId)).toEqual([request]);
    await controls.acknowledge(request);
    expect(await controls.pending(runId)).toEqual([]);

    await lease.release();
    expect(await controls.executorPresent(runId)).toBe(false);
    await (await controls.acquire(runId)).release();
  });
});
