import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  OrchestrationEventV1Schema,
  RunIdSchema,
  type OrchestrationEventV1,
} from "@honeybee/orchestration-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore, FileOrchestrationJournal, FileRunRepository } from "./file-storage.js";

const directories: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-runs-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const event = (
  runId: ReturnType<typeof RunIdSchema.parse>,
  sequence: number,
  type: OrchestrationEventV1["type"],
  payload: unknown,
): OrchestrationEventV1 =>
  OrchestrationEventV1Schema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    runId,
    sequence,
    timestamp: new Date(0).toISOString(),
    type,
    payload,
  });

describe("filesystem run persistence", () => {
  it("publishes identical concurrent content once without coupling Artifact ID to its path", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);

    const [first, second] = await Promise.all([
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind: "step-content",
        mediaType: "text/plain; charset=utf-8",
        content: "same content",
      }),
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind: "step-content",
        mediaType: "text/plain; charset=utf-8",
        content: "same content",
      }),
    ]);

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(first.contentDigest).toBe(second.contentDigest);
    const hex = first.contentDigest.slice("sha256:".length);
    const blobPath = path.join(root, runId, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
    expect(await readFile(blobPath, "utf8")).toBe("same content");
    expect(blobPath).not.toContain(first.artifactId);
  });

  it("revalidates every read and never overwrites a tampered existing blob", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const stored = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "original",
    });
    const hex = stored.contentDigest.slice("sha256:".length);
    const blobPath = path.join(root, runId, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
    await writeFile(blobPath, "tampered", "utf8");

    await expect(store.get({ runId, artifact: stored })).rejects.toMatchObject({
      code: "artifact.integrity-failed",
    });
    await expect(
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind: "task",
        mediaType: "text/plain; charset=utf-8",
        content: "original",
      }),
    ).rejects.toMatchObject({ code: "artifact.integrity-failed" });
    expect(await readFile(blobPath, "utf8")).toBe("tampered");
  });

  it("uses only the Journal to determine terminal or indeterminate Run state", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const journal = new FileOrchestrationJournal(root);
    await journal.append(runId, event(runId, 1, "workflow.started", { stepCount: 2 }));
    await journal.append(
      runId,
      event(runId, 2, "workflow.failed", { errorCode: "agent.spawn-failed" }),
    );

    await new FileArtifactStore(root).put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "step-content",
      mediaType: "text/plain; charset=utf-8",
      content: "unreferenced orphan",
    });

    expect((await journal.replay(runId)).status).toBe("terminal");

    const beforeRejectedAppend = await readFile(path.join(root, runId, "events.jsonl"), "utf8");
    await expect(
      new FileOrchestrationJournal(root).append(
        runId,
        event(runId, 3, "workflow.failed", { errorCode: "must-not-append" }),
      ),
    ).rejects.toMatchObject({ code: "journal.write-failed" });
    expect(await readFile(path.join(root, runId, "events.jsonl"), "utf8")).toBe(
      beforeRejectedAppend,
    );

    const extra = event(runId, 3, "workflow.failed", { errorCode: "unexpected" });
    await appendFile(path.join(root, runId, "events.jsonl"), `${JSON.stringify(extra)}\n`, "utf8");
    expect((await new FileOrchestrationJournal(root).replay(runId)).status).toBe("indeterminate");
  });

  it("rejects partial journals and raw path-like run identifiers", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    const repository = new FileRunRepository(root);
    await repository.create(runId);
    await writeFile(path.join(root, runId, "events.jsonl"), '{"partial":true}', "utf8");
    expect((await new FileOrchestrationJournal(root).replay(runId)).status).toBe("indeterminate");
    await expect(repository.open("../escape" as typeof runId)).rejects.toBeDefined();
  });

  it("keeps a valid terminal Journal conclusive when its referenced Artifact is damaged", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const artifact = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "step-content",
      mediaType: "text/plain; charset=utf-8",
      content: "final",
    });
    const journal = new FileOrchestrationJournal(root);
    await journal.append(runId, event(runId, 1, "workflow.started", { stepCount: 2 }));
    await journal.append(runId, event(runId, 2, "workflow.completed", { result: artifact }));
    const hex = artifact.contentDigest.slice("sha256:".length);
    await writeFile(
      path.join(root, runId, "blobs", "sha256", hex.slice(0, 2), hex.slice(2)),
      "broken",
      "utf8",
    );

    expect((await journal.replay(runId)).status).toBe("terminal");
    await expect(store.get({ runId, artifact })).rejects.toMatchObject({
      code: "artifact.integrity-failed",
    });
  });

  it("does not accept generic error fields in Journal payloads", () => {
    const runId = RunIdSchema.parse(randomUUID());
    expect(() =>
      event(runId, 1, "workflow.failed", {
        errorCode: "agent.non-zero-exit",
        stderr: "secret",
      }),
    ).toThrow();
  });
});
