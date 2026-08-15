import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

  it("shares a successfully observed process identity across concurrent Run leases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const repository = new FileRunRepository(root);
    const controls = new FileRunControl(root);
    const runIds = Array.from({ length: 12 }, () => RunIdSchema.parse(randomUUID()));
    await Promise.all(runIds.map((runId) => repository.create(runId)));

    const leases = await Promise.all(runIds.map((runId) => controls.acquire(runId)));
    expect(await Promise.all(runIds.map((runId) => controls.executorPresent(runId)))).toEqual(
      Array.from({ length: runIds.length }, () => true),
    );

    await Promise.all(leases.map((lease) => lease.release()));
    expect(await Promise.all(runIds.map((runId) => controls.executorPresent(runId)))).toEqual(
      Array.from({ length: runIds.length }, () => false),
    );
  });

  it("publishes complete control requests atomically and ignores private temporary files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const controls = new FileRunControl(root);
    const request = {
      requestId: EventIdSchema.parse(randomUUID()),
      runId,
      action: "pause" as const,
      timestamp: new Date().toISOString(),
    };

    await Promise.all(Array.from({ length: 8 }, () => controls.submit(request)));
    const inbox = path.join(root, runId, "control", "inbox");
    await writeFile(path.join(inbox, ".partial.tmp"), "{", "utf8");

    expect(await controls.pending(runId)).toEqual([request]);
    expect((await readdir(inbox)).filter((name) => name.endsWith(".json"))).toEqual([
      `${request.requestId}.json`,
    ]);
  });

  it("does not recreate a Run that was deleted before control publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    const repository = new FileRunRepository(root);
    await repository.create(runId);
    await repository.delete(runId);

    await expect(
      new FileRunControl(root).submit({
        requestId: EventIdSchema.parse(randomUUID()),
        runId,
        action: "cancel",
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "run.not-found" });
    await expect(lstat(path.join(root, runId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows exactly one atomic takeover of a stale executor lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const active = path.join(root, ".leases", "active", runId);
    await mkdir(active, { recursive: true });
    await writeFile(
      path.join(active, "owner.json"),
      `${JSON.stringify({ schemaVersion: 1, leaseId: randomUUID(), pid: 2_147_483_647 })}\n`,
      "utf8",
    );

    const controls = new FileRunControl(root);
    const attempts = await Promise.allSettled([controls.acquire(runId), controls.acquire(runId)]);
    const acquired = attempts.find((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(acquired?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "run.already-running" });
    }
    expect(await controls.executorPresent(runId)).toBe(true);
    expect(await readdir(path.join(root, ".leases", "stale"))).toHaveLength(1);
    if (acquired?.status === "fulfilled") await acquired.value.release();
    expect(await controls.executorPresent(runId)).toBe(false);
  });

  it("treats a reused PID with a different process incarnation as stale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const active = path.join(root, ".leases", "active", runId);
    await mkdir(active, { recursive: true });
    await writeFile(
      path.join(active, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        leaseId: randomUUID(),
        pid: process.pid,
        processIdentity: "win32:impossible-incarnation",
      })}\n`,
      "utf8",
    );

    const controls = new FileRunControl(root);
    expect(await controls.executorPresent(runId)).toBe(false);
    const lease = await controls.acquire(runId);
    expect(await controls.executorPresent(runId)).toBe(true);
    expect(await readdir(path.join(root, ".leases", "stale"))).toHaveLength(1);
    await lease.release();
  });

  it("keeps the exclusive lease valid while the Run directory is deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-control-"));
    directories.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    const repository = new FileRunRepository(root);
    await repository.create(runId);
    const controls = new FileRunControl(root);
    const deletionLease = await controls.acquire(runId);

    await expect(controls.acquire(runId)).rejects.toMatchObject({ code: "run.already-running" });
    await repository.delete(runId);
    expect(await controls.executorPresent(runId)).toBe(true);
    await deletionLease.release();
    expect(await controls.executorPresent(runId)).toBe(false);
  });
});
