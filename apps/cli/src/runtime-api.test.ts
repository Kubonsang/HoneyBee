import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  OrchestrationEventV5Schema,
  RunIdSchema,
  type ArtifactRef,
  type OrchestrationEventV5,
  type RunId,
} from "@honeybee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HoneyBeeRuntimeFacade } from "./runtime-api.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-runtime-api-"));
  roots.push(root);
  return root;
};

const event = (
  runId: RunId,
  sequence: number,
  type: OrchestrationEventV5["type"],
  payload: unknown,
): OrchestrationEventV5 =>
  OrchestrationEventV5Schema.parse({
    schemaVersion: 5,
    eventId: EventIdSchema.parse(randomUUID()),
    runId,
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    type,
    payload,
  });

const seedRun = async (
  root: string,
  projectPath: string,
  terminal: boolean,
): Promise<Readonly<{ runId: RunId; config: ArtifactRef; unreferenced: ArtifactRef }>> => {
  const runId = RunIdSchema.parse(randomUUID());
  await new FileRunRepository(root).create(runId);
  const artifacts = new FileArtifactStore(root);
  const config = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "workflow-config",
    mediaType: "application/json",
    content: JSON.stringify({ sourceProjectPath: projectPath }),
  });
  const task = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "task",
    mediaType: "text/plain; charset=utf-8",
    content: "make a safe change",
  });
  const unreferenced = await artifacts.put({
    runId,
    artifactId: ArtifactIdSchema.parse(randomUUID()),
    kind: "step-content",
    mediaType: "text/plain; charset=utf-8",
    content: "not journal-authorized",
  });
  const journal = new FileOrchestrationJournal(root);
  const values = [
    event(runId, 1, "workflow.started", {
      mode: "unity-work-v3",
      config,
      task,
      linkage: {
        workId: "unity-work",
        poolId: "unity-editors",
        priority: "validation",
        capabilityCount: 1,
      },
    }),
    event(runId, 2, "artifact.stored", { artifact: config }),
    event(runId, 3, "artifact.stored", { artifact: task }),
  ];
  for (const value of values) await journal.append(runId, value);
  if (terminal) {
    await journal.append(
      runId,
      event(runId, 4, "workflow.failed", {
        failure: { errorCode: "workspace.preflight-failed" },
      }),
    );
  }
  return { runId, config, unreferenced };
};

describe("HoneyBeeRuntimeFacade", () => {
  it("derives history and detail from the authoritative Journal", async () => {
    const root = await temporaryRoot();
    const projectPath = path.join(root, "source-project");
    const seeded = await seedRun(root, projectPath, true);
    const facade = new HoneyBeeRuntimeFacade({ stateRoot: root });

    const detail = await facade.getRunDetail(seeded.runId);
    expect(detail.summary).toMatchObject({
      runId: seeded.runId,
      mode: "unity-work-v3",
      status: "failed",
      terminal: true,
      projectPath,
      allowedActions: [],
    });
    expect(detail.failure).toEqual({ errorCode: "workspace.preflight-failed" });
    expect(detail.events).toHaveLength(4);
    expect(await facade.listRuns({ projectPath })).toEqual([detail.summary]);
  });

  it("reads only Artifacts referenced by the Run Journal", async () => {
    const root = await temporaryRoot();
    const seeded = await seedRun(root, path.join(root, "source"), true);
    const facade = new HoneyBeeRuntimeFacade({ stateRoot: root });

    const view = await facade.readReferencedArtifact(seeded.runId, seeded.config.artifactId);
    expect(view.encoding).toBe("utf8");
    expect(JSON.parse(view.content)).toHaveProperty("sourceProjectPath");
    await expect(
      facade.readReferencedArtifact(seeded.runId, seeded.unreferenced.artifactId),
    ).rejects.toMatchObject({ code: "artifact.read-failed" });
  });

  it("fails the read model closed when a referenced config Artifact is corrupt", async () => {
    const root = await temporaryRoot();
    const seeded = await seedRun(root, path.join(root, "source"), true);
    const digest = seeded.config.contentDigest.slice("sha256:".length);
    await writeFile(
      path.join(root, seeded.runId, "blobs", "sha256", digest.slice(0, 2), digest.slice(2)),
      "tampered",
      "utf8",
    );

    const detail = await new HoneyBeeRuntimeFacade({ stateRoot: root }).getRunDetail(seeded.runId);
    expect(detail.summary).toMatchObject({
      status: "indeterminate",
      terminal: false,
      allowedActions: [],
    });
  });

  it("offers Resume and Cancel only for an inactive, conclusive v0.6 Run", async () => {
    const root = await temporaryRoot();
    const seeded = await seedRun(root, path.join(root, "source"), false);
    const detail = await new HoneyBeeRuntimeFacade({ stateRoot: root }).getRunDetail(seeded.runId);

    expect(detail.summary.status).toBe("cleanup-pending");
    expect(detail.summary.allowedActions).toEqual(["cancel", "resume"]);
  });

  it("releases the executor lease when resumed config validation fails", async () => {
    const root = await temporaryRoot();
    const seeded = await seedRun(root, path.join(root, "source"), false);
    const facade = new HoneyBeeRuntimeFacade({ stateRoot: root });

    expect(await facade.resume(seeded.runId)).toMatchObject({
      action: "resume",
      disposition: "started",
    });
    await vi.waitFor(async () =>
      expect(await new FileRunControl(root).executorPresent(seeded.runId)).toBe(false),
    );
  });

  it("reports invalid Doctor inputs without leaking parser or process output", async () => {
    const root = await temporaryRoot();
    const project = path.join(root, "project");
    await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((name) =>
        mkdir(path.join(project, name), { recursive: true }),
      ),
    );
    await writeFile(
      path.join(project, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.0.1f1\n",
      "utf8",
    );
    const configPath = path.join(root, "invalid.json");
    await writeFile(configPath, JSON.stringify({ secret: "must-not-appear" }), "utf8");

    const report = await new HoneyBeeRuntimeFacade({ stateRoot: path.join(root, "runs") }).doctor({
      schemaVersion: 1,
      projectPath: project,
      batchConfigPath: configPath,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "config.batch", status: "fail", code: "config.invalid" }),
    );
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "agent.probe", code: "agent.probe-skipped" }),
    );
  });
});
