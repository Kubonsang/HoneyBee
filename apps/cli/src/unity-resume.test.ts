import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArtifactIdSchema,
  EventIdSchema,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  OrchestrationEventV3Schema,
  RunIdSchema,
  UnityWorkConfigV1Schema,
  type AgentProcessResult,
  type AgentProcessRunner,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "./unity-adapters.js";
import { UnityWorkTransaction } from "./unity-transaction.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class CompletedRunner implements AgentProcessRunner {
  public calls = 0;

  public async run(
    request: Parameters<AgentProcessRunner["run"]>[0],
    lifecycle: Parameters<AgentProcessRunner["run"]>[1],
  ): Promise<AgentProcessResult> {
    this.calls += 1;
    await lifecycle.onStarted(9001);
    const match = request.prompt.match(
      /HONEYBEE_INPUT_BEGIN\r?\n([\s\S]*?)\r?\nHONEYBEE_INPUT_END/u,
    );
    if (match?.[1] === undefined) throw new Error("missing input");
    const input = JSON.parse(match[1]) as { runId: string; step: { id: string } };
    await writeFile(
      path.join(request.command.cwd as string, "Assets", "agent-created.txt"),
      "workspace only\n",
      "utf8",
    );
    const observation = {
      pid: 9001,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 1,
      stderrBytes: 0,
    } as const;
    await lifecycle.onExited(observation);
    return {
      ...observation,
      stepId: request.stepId,
      command: request.command.command,
      termination: "exited",
      stdout:
        "HONEYBEE_RESPONSE_BEGIN\n" +
        JSON.stringify({
          schemaVersion: 2,
          runId: input.runId,
          stepId: input.step.id,
          status: "completed",
          outputs: {
            content: {
              mediaType: "text/plain; charset=utf-8",
              content: "done",
            },
          },
        }) +
        "\nHONEYBEE_RESPONSE_END\n",
      stderr: "",
    };
  }
}

describe("UnityWorkTransaction cleanup resume", () => {
  it("removes a partial shell left by a crash before workspace.prepared", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-prepare-crash-"));
    directories.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runRoot = path.join(root, "runs");
    await mkdir(workspaceRoot, { recursive: true });
    const storageBinarySha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const hex = (value: string) => value.repeat(64);
    const config = UnityWorkConfigV1Schema.parse({
      schemaVersion: 1,
      sourceProjectPath: path.join(root, "source"),
      workspaceStorage: {
        command: { command: process.execPath },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: storageBinarySha256,
        workspaceRoot,
        parentKey: {
          schemaVersion: 2,
          digest: hex("a"),
          libraryKey: {
            schemaVersion: "1",
            digest: hex("b"),
            unityVersion: "6000",
            unityExecutableSha256: hex("c"),
            manifestSha256: hex("d"),
            packagesLockSha256: "missing",
            projectSettingsSha256: hex("e"),
            buildTarget: "windows/amd64",
            scriptingBackend: "Mono",
            projectIdentitySha256: hex("f"),
          },
          provider: "vhdx-differencing",
          filesystem: "NTFS",
          virtualBytes: 1,
          blockBytes: 1,
          sectorBytes: 1,
        },
      },
      agent: {
        command: { command: "must-not-run" },
        harness: "stdio-framed-v2",
      },
      testplay: {
        command: { command: "must-not-run" },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 1,
      },
    });
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(runRoot).create(runId);
    const artifacts = new FileArtifactStore(runRoot);
    const configArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "workflow-config",
      mediaType: "application/json",
      content: JSON.stringify(config),
    });
    const taskArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "task",
      mediaType: "text/plain; charset=utf-8",
      content: "task",
    });
    const sourceArtifact = await artifacts.put({
      runId,
      artifactId: ArtifactIdSchema.parse(randomUUID()),
      kind: "unity-source-manifest",
      mediaType: "application/json",
      content: "{}",
    });
    const journal = new FileOrchestrationJournal(runRoot);
    const append = async (
      sequence: number,
      type: "workflow.started" | "artifact.stored" | "source.baselined",
      payload: unknown,
    ): Promise<void> => {
      await journal.append(
        runId,
        OrchestrationEventV3Schema.parse({
          schemaVersion: 3,
          eventId: EventIdSchema.parse(randomUUID()),
          runId,
          sequence,
          timestamp: new Date(0).toISOString(),
          type,
          payload,
        }),
      );
    };
    await append(1, "workflow.started", {
      mode: "unity-work-v1",
      config: configArtifact,
      task: taskArtifact,
    });
    await append(2, "artifact.stored", { artifact: configArtifact });
    await append(3, "artifact.stored", { artifact: taskArtifact });
    await append(4, "artifact.stored", { artifact: sourceArtifact });
    await append(5, "source.baselined", { manifest: sourceArtifact });

    const workspacePath = path.join(workspaceRoot, "hb-" + runId);
    await mkdir(path.join(workspacePath, "Assets"), { recursive: true });
    await writeFile(path.join(workspacePath, "Assets", "partial.txt"), "partial", "utf8");
    const runner = new CompletedRunner();
    const transaction = new UnityWorkTransaction(
      runner,
      artifacts,
      journal,
      new FileRunControl(runRoot),
      new UnityProjectBootstrap(),
      new UnityWorkspaceStorageCliAdapter(
        config.workspaceStorage.command,
        config.workspaceStorage.parentKey.provider,
        config.workspaceStorage.binarySha256,
      ),
      new TestPlayCliAdapter(config.testplay),
    );

    const result = await transaction.resume(runId, config);

    expect(result.status).toBe("failed");
    expect(result.failure?.errorCode).toBe("transaction.interrupted");
    expect(runner.calls).toBe(0);
    await expect(access(workspacePath)).rejects.toBeDefined();
    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.terminal.type).toBe("workflow.failed");
    }
  });

  it("retries only release after a durable release failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-resume-"));
    directories.push(root);
    const source = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspaces");
    const runRoot = path.join(root, "runs");
    await Promise.all([
      mkdir(path.join(source, "Assets"), { recursive: true }),
      mkdir(path.join(source, "Packages"), { recursive: true }),
      mkdir(path.join(source, "ProjectSettings"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(source, "Assets", "Game.cs"), "class Game {}\n", "utf8"),
      writeFile(path.join(source, "Packages", "manifest.json"), "{}\n", "utf8"),
      writeFile(
        path.join(source, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.0f1\n",
        "utf8",
      ),
      writeFile(path.join(workspaceRoot, "fail-release-once"), "1", "utf8"),
    ]);
    const storageScript = path.join(root, "storage.mjs");
    await writeFile(
      storageScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "const op = args[1];",
        "const root = process.cwd();",
        "if (op === 'acquire') {",
        " let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);",
        " process.stdin.on('end', () => { const r = JSON.parse(input); const id = 'lease-' + r.workspaceId; fs.mkdirSync(path.join(root, 'Library')); fs.writeFileSync(path.join(path.dirname(root), id + '.json'), JSON.stringify({ workspace: root })); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: r.requestId, provider: r.parentKey.provider, lease: { leaseId: id, runId: r.consumerId, parentKey: r.parentKey.digest, mountPath: path.join(root, 'Library'), state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n'); });",
        "} else if (op === 'release') {",
        " const id = args[args.indexOf('--lease-id') + 1]; const requestId = args[args.indexOf('--request-id') + 1]; const fail = path.join(root, 'fail-release-once');",
        " if (fs.existsSync(fail)) { fs.rmSync(fail); process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, operation: 'release', error: { code: 'workspace-command-failed', message: 'injected' } }) + '\\n'); process.exitCode = 1; }",
        " else { const map = path.join(root, id + '.json'); const data = JSON.parse(fs.readFileSync(map, 'utf8')); fs.rmSync(data.workspace, { recursive: true, force: true }); fs.rmSync(map); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, provider: 'vhdx-differencing', metrics: { cleanupState: 'released' } }) + '\\n'); }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const testplayScript = path.join(root, "testplay.mjs");
    await writeFile(
      testplayScript,
      [
        "import fs from 'node:fs'; import path from 'node:path';",
        "const a = process.argv.slice(2); const c = JSON.parse(fs.readFileSync(a[a.indexOf('--config') + 1], 'utf8'));",
        "const count = path.join(path.dirname(c.project_path), 'testplay-count'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));",
        "const id = 'run'; const r = path.join(c.project_path, '.testplay', 'runs', id); fs.mkdirSync(r, { recursive: true });",
        "const f = { 'results.xml': '<ok />', 'summary.json': '{}', 'manifest.json': '{}', 'stdout.log': '', 'stderr.log': '', 'events.ndjson': '{}\\n' }; for (const [n, v] of Object.entries(f)) fs.writeFileSync(path.join(r, n), v);",
        "process.stdout.write(JSON.stringify({ schema_version: '1', run_id: id }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    const hex = (value: string) => value.repeat(64);
    const storageBinarySha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const config = UnityWorkConfigV1Schema.parse({
      schemaVersion: 1,
      sourceProjectPath: source,
      workspaceStorage: {
        command: { command: process.execPath, args: [storageScript] },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: storageBinarySha256,
        workspaceRoot,
        parentKey: {
          schemaVersion: 2,
          digest: hex("a"),
          libraryKey: {
            schemaVersion: "1",
            digest: hex("b"),
            unityVersion: "6000",
            unityExecutableSha256: hex("c"),
            manifestSha256: hex("d"),
            packagesLockSha256: "missing",
            projectSettingsSha256: hex("e"),
            buildTarget: "windows/amd64",
            scriptingBackend: "Mono",
            projectIdentitySha256: hex("f"),
          },
          provider: "vhdx-differencing",
          filesystem: "NTFS",
          virtualBytes: 1,
          blockBytes: 1,
          sectorBytes: 1,
        },
      },
      agent: {
        command: { command: "in-memory" },
        harness: "stdio-framed-v2",
      },
      testplay: {
        command: { command: process.execPath, args: [testplayScript] },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 10_000,
      },
    });
    const runId = RunIdSchema.parse(randomUUID());
    await new FileRunRepository(runRoot).create(runId);
    const controls = new FileRunControl(runRoot);
    const journal = new FileOrchestrationJournal(runRoot);
    const runner = new CompletedRunner();
    const transaction = new UnityWorkTransaction(
      runner,
      new FileArtifactStore(runRoot),
      journal,
      controls,
      new UnityProjectBootstrap(),
      new UnityWorkspaceStorageCliAdapter(
        config.workspaceStorage.command,
        config.workspaceStorage.parentKey.provider,
        config.workspaceStorage.binarySha256,
      ),
      new TestPlayCliAdapter(config.testplay),
    );
    const first = await transaction.run(runId, "change Unity", config);
    expect(first.status).toBe("cleanup-pending");
    expect(runner.calls).toBe(1);
    expect((await journal.replay(runId)).status).toBe("active");

    const resumed = await transaction.resume(runId, config);
    expect(resumed.status).toBe("completed");
    expect(resumed.evidence?.kind).toBe("testplay-evidence");
    expect(runner.calls).toBe(1);
    expect(await readFile(path.join(workspaceRoot, "testplay-count"), "utf8")).toBe("1");
    await expect(access(path.join(workspaceRoot, "hb-" + runId))).rejects.toBeDefined();
    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.events.filter((event) => event.type === "agent.started")).toHaveLength(1);
      expect(replay.events.at(-1)?.type).toBe("workflow.completed");
    }
  }, 30_000);
});
