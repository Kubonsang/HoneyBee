import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  OrchestrationEventV6Schema,
  RunIdSchema,
  StepIdSchema,
  type ArtifactKind,
  type ArtifactRef,
  type OrchestrationEventV6,
} from "@honeybee/orchestration-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore, FileOrchestrationJournal, FileRunRepository } from "./file-storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Journal schema v6", () => {
  it("replays a durable session approval round trip and rejects a mismatched turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-v6-journal-"));
    roots.push(root);
    const runId = RunIdSchema.parse(randomUUID());
    const stepId = StepIdSchema.parse("unity-agent");
    await new FileRunRepository(root).create(runId);
    const store = new FileArtifactStore(root);
    const put = (kind: ArtifactKind, content = "{}") =>
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind,
        mediaType: kind === "task" ? "text/plain; charset=utf-8" : "application/json",
        content,
      });
    const [
      config,
      task,
      source,
      acquireRequest,
      acquireReceipt,
      input,
      approvalRequest,
      decision,
      transcript,
    ] = await Promise.all([
      put("workflow-config"),
      put("task", "task"),
      put("unity-source-manifest"),
      put("workspace-acquire-request"),
      put("workspace-acquire-receipt"),
      put("step-input"),
      put("agent-approval-request"),
      put("approval-decision"),
      store.put({
        runId,
        artifactId: ArtifactIdSchema.parse(randomUUID()),
        kind: "agent-session-transcript",
        mediaType: "application/x-ndjson",
        content: "{}\n",
      }),
    ]);
    let sequence = 0;
    const journal = new FileOrchestrationJournal(root);
    const append = async (
      type: OrchestrationEventV6["type"],
      payload: unknown,
      scoped = false,
      eventId = EventIdSchema.parse(randomUUID()),
    ) => {
      const event = OrchestrationEventV6Schema.parse({
        schemaVersion: 6,
        eventId,
        runId,
        sequence: ++sequence,
        timestamp: new Date(sequence).toISOString(),
        type,
        ...(scoped ? { stepId } : {}),
        payload,
      });
      await journal.append(runId, event);
      return event;
    };
    const stored = (artifact: ArtifactRef, scoped = false) =>
      append("artifact.stored", { artifact }, scoped);
    await append("workflow.started", {
      mode: "unity-work-v3",
      config,
      task,
      linkage: {
        workId: "unity-work",
        poolId: "unity-editor",
        priority: "validation",
        capabilityCount: 0,
      },
    });
    await stored(config);
    await stored(task);
    await stored(source);
    await append("source.baselined", { manifest: source });
    await append("workspace.prepared", { workspaceId: "workspace", sourceManifest: source });
    await stored(acquireRequest);
    await append("workspace.acquire-started", {
      request: acquireRequest,
      requestId: "request",
    });
    await stored(acquireReceipt);
    await append("workspace.acquired", {
      workspaceId: "workspace",
      leaseId: "lease",
      receipt: acquireReceipt,
    });
    await stored(input, true);
    await append("work.admission-queued", { priority: "validation" }, true);
    await append("work.admission-entered", { priority: "validation", waitMs: 5 }, true);
    const startedId = EventIdSchema.parse(randomUUID());
    await append(
      "agent.started",
      { pid: 42, processIdentity: "identity", containment: "deferred-v1" },
      true,
      startedId,
    );
    await append(
      "process.containment-registered",
      { process: "agent", startedEventId: startedId },
      true,
    );
    const turnDigest = "sha256:" + "1".repeat(64);
    await append(
      "agent.session-opened",
      {
        adapter: "codex-app-server-v1",
        sessionIdDigest: "sha256:" + "0".repeat(64),
        capabilities: {
          schemaVersion: 1,
          adapter: "codex-app-server-v1",
          toolApproval: "root-only",
          skills: "observe-only",
          plan: "unsupported",
          resume: "unsupported",
          steer: "unsupported",
          userInput: "unsupported",
          subagentApproval: "unsupported",
          plugins: "disabled",
        },
      },
      true,
    );
    await append("agent.turn-started", { turnIdDigest: turnDigest }, true);
    await stored(approvalRequest, true);
    const approvalId = EventIdSchema.parse(randomUUID());
    await append(
      "agent.approval-requested",
      { approvalId, kind: "command", request: approvalRequest },
      true,
    );
    await stored(decision, true);
    await append(
      "agent.approval-resolved",
      { approvalId, decision: "deny", source: "user", receipt: decision },
      true,
    );
    await append("agent.approval-delivered", { approvalId }, true);
    await expect(
      append(
        "agent.turn-completed",
        {
          turnIdDigest: "sha256:" + "2".repeat(64),
          status: "completed",
          outputBytes: 2,
        },
        true,
      ),
    ).rejects.toThrow("transition");
    sequence -= 1;
    await append(
      "agent.turn-completed",
      { turnIdDigest: turnDigest, status: "completed", outputBytes: 2 },
      true,
    );
    await stored(transcript, true);
    await append("agent.session-closed", { reason: "completed", transcript }, true);
    await append(
      "agent.exited",
      {
        pid: 42,
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdoutBytes: 2,
        stderrBytes: 0,
      },
      true,
    );
    await append("process.drain-completed", { process: "agent", startedEventId: startedId }, true);
    expect((await journal.replay(runId)).status).toBe("active");
  });
});
