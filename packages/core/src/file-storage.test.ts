import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  OrchestrationEventV2Schema,
  OrchestrationEventV1Schema,
  OrchestrationEventV3Schema,
  RunIdSchema,
  type OrchestrationEventV1,
  type OrchestrationEventV2,
  type OrchestrationEventV3,
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

const eventV2 = (
  runId: ReturnType<typeof RunIdSchema.parse>,
  sequence: number,
  type: OrchestrationEventV2["type"],
  payload: unknown,
  stepId?: string,
): OrchestrationEventV2 =>
  OrchestrationEventV2Schema.parse({
    schemaVersion: 2,
    eventId: EventIdSchema.parse(randomUUID()),
    runId,
    sequence,
    timestamp: new Date(0).toISOString(),
    type,
    ...(stepId === undefined ? {} : { stepId }),
    payload,
  });

const eventV3 = (
  runId: ReturnType<typeof RunIdSchema.parse>,
  sequence: number,
  type: OrchestrationEventV3["type"],
  payload: unknown,
  stepId?: string,
): OrchestrationEventV3 =>
  OrchestrationEventV3Schema.parse({
    schemaVersion: 3,
    eventId: EventIdSchema.parse(randomUUID()),
    runId,
    sequence,
    timestamp: new Date(0).toISOString(),
    type,
    ...(stepId === undefined ? {} : { stepId }),
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

  it("replays a valid v2 nonterminal Journal and rejects impossible transitions", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const config = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: "{}",
    });
    const task = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const journal = new FileOrchestrationJournal(root);
    await journal.append(
      runId,
      eventV2(runId, 1, "workflow.started", {
        stepCount: 1,
        maxParallelism: 1,
        config,
        task,
      }),
    );
    await journal.append(runId, eventV2(runId, 2, "artifact.stored", { artifact: config }));
    await journal.append(runId, eventV2(runId, 3, "artifact.stored", { artifact: task }));
    expect((await journal.replay(runId)).status).toBe("active");

    await expect(
      journal.append(runId, eventV2(runId, 4, "agent.started", { attempt: 1, pid: 42 }, "worker")),
    ).rejects.toMatchObject({ code: "journal.write-failed" });
    await journal.append(runId, eventV2(runId, 4, "workflow.completed", { outputs: {} }));
    expect((await journal.replay(runId)).status).toBe("terminal");
    await expect(
      new FileOrchestrationJournal(root).append(
        runId,
        eventV2(runId, 5, "workflow.failed", { errorCode: "late" }),
      ),
    ).rejects.toMatchObject({ code: "journal.write-failed" });
  });

  it("requires Unity validation before completion and correlates the terminal outcome", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const put = (kind: Parameters<FileArtifactStore["put"]>[0]["kind"]) =>
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind,
        mediaType: "application/json",
        content: "{}",
      });
    const [config, task, source, request, receipt, evidence, release] = await Promise.all([
      put("workflow-config"),
      put("task"),
      put("unity-source-manifest"),
      put("workspace-acquire-request"),
      put("workspace-acquire-receipt"),
      put("testplay-evidence"),
      put("workspace-release-receipt"),
    ]);
    const journal = new FileOrchestrationJournal(root);
    const events: OrchestrationEventV3[] = [
      eventV3(runId, 1, "workflow.started", {
        mode: "unity-work-v1",
        config,
        task,
      }),
      eventV3(runId, 2, "source.baselined", { manifest: source }),
      eventV3(runId, 3, "workspace.prepared", {
        workspaceId: "workspace",
        sourceManifest: source,
      }),
      eventV3(runId, 4, "workspace.acquire-started", {
        request,
        requestId: "acquire",
      }),
      eventV3(runId, 5, "workspace.acquired", {
        workspaceId: "workspace",
        leaseId: "lease",
        receipt,
      }),
    ];
    for (const entry of events) await journal.append(runId, entry);

    await expect(
      journal.append(
        runId,
        eventV3(runId, 6, "transaction.outcome-decided", { outcome: "completed" }),
      ),
    ).rejects.toMatchObject({ code: "journal.write-failed" });

    const observation = {
      pid: 42,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const validated: OrchestrationEventV3[] = [
      eventV3(runId, 6, "agent.started", { pid: 42 }, "unity-agent"),
      eventV3(runId, 7, "agent.exited", observation, "unity-agent"),
      eventV3(runId, 8, "testplay.started", { pid: 43 }),
      eventV3(runId, 9, "testplay.exited", { ...observation, pid: 43 }),
      eventV3(runId, 10, "testplay.evidence-stored", { evidence }),
      eventV3(runId, 11, "testplay.verified", { evidence }),
      eventV3(runId, 12, "source.checked", {
        before: source,
        after: source,
        unchanged: true,
      }),
      eventV3(runId, 13, "transaction.outcome-decided", {
        outcome: "failed",
        failure: { errorCode: "test.failure" },
      }),
      eventV3(runId, 14, "workspace.release-started", {
        leaseId: "lease",
        requestId: "release",
      }),
      eventV3(runId, 15, "workspace.released", {
        leaseId: "lease",
        receipt: release,
        cleanupState: "released",
      }),
    ];
    for (const entry of validated) await journal.append(runId, entry);

    await expect(
      journal.append(
        runId,
        eventV3(runId, 16, "workflow.completed", {
          evidence,
          release,
          sourceAfter: source,
        }),
      ),
    ).rejects.toMatchObject({ code: "journal.write-failed" });
    await journal.append(
      runId,
      eventV3(runId, 16, "workflow.failed", {
        failure: { errorCode: "test.failure" },
        release,
        sourceAfter: source,
      }),
    );
    expect((await journal.replay(runId)).status).toBe("terminal");
  });

  it("rejects outcomes and retries that do not match the active Agent attempt", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const config = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: "{}",
    });
    const task = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const input = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "step-input",
      mediaType: "application/json",
      content: "{}",
    });
    const reason = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "blocked-reason",
      mediaType: "text/plain; charset=utf-8",
      content: "reason",
    });
    const journal = new FileOrchestrationJournal(root);
    const events: OrchestrationEventV2[] = [
      eventV2(runId, 1, "workflow.started", {
        stepCount: 1,
        maxParallelism: 1,
        config,
        task,
      }),
      eventV2(runId, 2, "artifact.stored", { artifact: config }),
      eventV2(runId, 3, "artifact.stored", { artifact: task }),
      eventV2(runId, 4, "artifact.stored", { artifact: input }, "worker"),
      eventV2(
        runId,
        5,
        "step.attempt.started",
        { attempt: 1, agentId: "worker", harnessId: "stdio", input },
        "worker",
      ),
      eventV2(
        runId,
        6,
        "step.assigned",
        { attempt: 1, agentId: "worker", harnessId: "stdio" },
        "worker",
      ),
      eventV2(runId, 7, "agent.started", { attempt: 1, pid: 42 }, "worker"),
      eventV2(
        runId,
        8,
        "agent.exited",
        {
          attempt: 1,
          pid: 42,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutDigest: `sha256:${"0".repeat(64)}`,
          stderrDigest: `sha256:${"0".repeat(64)}`,
        },
        "worker",
      ),
    ];
    for (const entry of events) await journal.append(runId, entry);

    const invalidOutcomes = [
      eventV2(runId, 9, "step.completed", { attempt: 2, outputs: {} }, "worker"),
      eventV2(runId, 9, "step.blocked", { attempt: 2, reason }, "worker"),
      eventV2(runId, 9, "step.escalated", { attempt: 2, reason, question: reason }, "worker"),
      eventV2(runId, 9, "step.attempt.interrupted", { attempt: 2 }, "worker"),
      eventV2(runId, 9, "step.cancelled", { attempt: 2 }, "worker"),
    ];
    for (const invalid of invalidOutcomes) {
      await expect(journal.append(runId, invalid)).rejects.toMatchObject({
        code: "journal.write-failed",
      });
    }

    await journal.append(
      runId,
      eventV2(
        runId,
        9,
        "step.attempt.failed",
        { attempt: 1, errorCode: "agent.non-zero-exit" },
        "worker",
      ),
    );
    await expect(
      journal.append(
        runId,
        eventV2(
          runId,
          10,
          "retry.scheduled",
          {
            attempt: 3,
            errorCode: "agent.non-zero-exit",
            notBefore: new Date(0).toISOString(),
          },
          "worker",
        ),
      ),
    ).rejects.toMatchObject({ code: "journal.write-failed" });

    await journal.append(
      runId,
      eventV2(
        runId,
        10,
        "retry.scheduled",
        {
          attempt: 2,
          errorCode: "agent.non-zero-exit",
          notBefore: new Date(0).toISOString(),
        },
        "worker",
      ),
    );
    const requestId = EventIdSchema.parse(randomUUID());
    await journal.append(
      runId,
      eventV2(runId, 11, "control.accepted", { requestId, action: "cancel" }),
    );
    await journal.append(runId, eventV2(runId, 12, "workflow.cancelling", { requestId }));
    await journal.append(
      runId,
      eventV2(runId, 13, "step.skipped", { reason: "workflow-cancelled" }, "worker"),
    );
    await journal.append(runId, eventV2(runId, 14, "workflow.cancelled", {}));
    expect((await journal.replay(runId)).status).toBe("terminal");
  });

  it("accepts interrupted-to-cancelled closure after restoring a cancelling Run", async () => {
    const root = await temporaryRoot();
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const config = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: "{}",
    });
    const task = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const input = await store.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "step-input",
      mediaType: "application/json",
      content: "{}",
    });
    const requestId = EventIdSchema.parse(randomUUID());
    const journal = new FileOrchestrationJournal(root);
    const events: OrchestrationEventV2[] = [
      eventV2(runId, 1, "workflow.started", {
        stepCount: 1,
        maxParallelism: 1,
        config,
        task,
      }),
      eventV2(runId, 2, "artifact.stored", { artifact: config }),
      eventV2(runId, 3, "artifact.stored", { artifact: task }),
      eventV2(runId, 4, "artifact.stored", { artifact: input }, "worker"),
      eventV2(
        runId,
        5,
        "step.attempt.started",
        { attempt: 1, agentId: "worker", harnessId: "stdio", input },
        "worker",
      ),
      eventV2(
        runId,
        6,
        "step.assigned",
        { attempt: 1, agentId: "worker", harnessId: "stdio" },
        "worker",
      ),
      eventV2(runId, 7, "agent.started", { attempt: 1, pid: 42 }, "worker"),
      eventV2(runId, 8, "control.accepted", { requestId, action: "cancel" }),
      eventV2(runId, 9, "workflow.cancelling", { requestId }),
      eventV2(runId, 10, "step.attempt.interrupted", { attempt: 1 }, "worker"),
      eventV2(runId, 11, "step.cancelled", { attempt: 1 }, "worker"),
      eventV2(runId, 12, "workflow.cancelled", {}),
    ];
    for (const entry of events) await journal.append(runId, entry);

    expect((await journal.replay(runId)).status).toBe("terminal");
  });
});
