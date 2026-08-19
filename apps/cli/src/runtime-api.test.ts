import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const doctorFixture = async (root: string, protocolV3: boolean) => {
  const project = path.join(root, "project");
  const workspaceRoot = path.join(root, "workspaces");
  const stateRoot = path.join(root, "runs");
  await Promise.all([
    ...["Assets", "Packages", "ProjectSettings"].map((name) =>
      mkdir(path.join(project, name), { recursive: true }),
    ),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(project, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.0.1f1\n",
    "utf8",
  );
  const testplay = path.join(root, "testplay.mjs");
  await writeFile(
    testplay,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') { process.stdout.write(JSON.stringify({ version: 'v0.14.0-test' }) + '\\n'); process.exit(0); }",
      protocolV3
        ? "if (args[0] === 'capability' && args[2] === '--help') { const common = '--require-bridge-session --require-editor-pid --workspace-id --no-fallback'; process.stdout.write(common + (args[1] === 'warm-test' ? ' --filter --category' : '') + '\\n'); process.exit(0); }"
        : "if (args[0] === 'capability') process.exit(2);",
      "process.exit(2);",
    ].join("\n"),
    "utf8",
  );
  const executableDigest = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  const configPath = path.join(root, "batch.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 3,
      mode: "unity-batch",
      resourceScope: "global-editor-pool-v2",
      maxParallelWorks: 1,
      transaction: {
        schemaVersion: 1,
        sourceProjectPath: project,
        workspaceStorage: {
          command: { command: process.execPath },
          contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
          binarySha256: executableDigest,
          workspaceRoot,
          parentKey: {
            schemaVersion: 2,
            digest: "a".repeat(64),
            libraryKey: {
              schemaVersion: "1",
              digest: "b".repeat(64),
              unityVersion: "6000.0.1f1",
              unityExecutableSha256: "c".repeat(64),
              manifestSha256: "d".repeat(64),
              packagesLockSha256: "missing",
              projectSettingsSha256: "e".repeat(64),
              buildTarget: "windows/amd64",
              scriptingBackend: "Mono",
              projectIdentitySha256: "f".repeat(64),
            },
            provider: "vhdx-differencing",
            filesystem: "NTFS",
            virtualBytes: 1024 * 1024 * 1024,
            blockBytes: 2 * 1024 * 1024,
            sectorBytes: 4096,
          },
        },
        agent: {
          command: { command: process.execPath },
          harness: "stdio-framed-v2",
        },
        testplay: {
          command: { command: process.execPath, args: [testplay] },
          unityPath: process.execPath,
          platform: "edit_mode",
          timeoutMs: 10_000,
        },
      },
      editorPool: {
        id: "unity-editors",
        capacity: 1,
        registrationTimeoutMs: 1_000,
        activationTimeoutMs: 1_000,
        bridgeReadyTimeoutMs: 1_000,
        capabilityTimeoutMs: 10_000,
        shutdownTimeoutMs: 1_000,
      },
      bridgeProtocolVersion: 3,
      works: [
        {
          id: "work-a",
          task: "Compile the fixture",
          priority: "interactive",
          capabilities: [{ id: "compile", kind: "compile" }],
        },
        {
          id: "work-b",
          task: "Warm-test the fixture",
          priority: "validation",
          capabilities: [{ id: "warm-test", kind: "warm-test" }],
        },
      ],
    }),
    "utf8",
  );
  return { project, stateRoot, configPath };
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

  it("accepts the side-effect-free TestPlay protocol v3 capability surface", async () => {
    const root = await temporaryRoot();
    const fixture = await doctorFixture(root, true);
    const report = await new HoneyBeeRuntimeFacade({ stateRoot: fixture.stateRoot }).doctor({
      schemaVersion: 1,
      projectPath: fixture.project,
      batchConfigPath: fixture.configPath,
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "testplay.protocol-v3",
        status: "pass",
        code: "testplay.protocol-v3-available",
        version: "v0.14.0-test",
      }),
    );
  });

  it("rejects a TestPlay executable without protocol v3 capability commands", async () => {
    const root = await temporaryRoot();
    const fixture = await doctorFixture(root, false);
    const report = await new HoneyBeeRuntimeFacade({ stateRoot: fixture.stateRoot }).doctor({
      schemaVersion: 1,
      projectPath: fixture.project,
      batchConfigPath: fixture.configPath,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "testplay.protocol-v3",
        status: "fail",
        code: "testplay.protocol-v3-unavailable",
      }),
    );
  });
});
