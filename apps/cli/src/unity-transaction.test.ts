import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ChildProcessAgentRunner,
  FileArtifactStore,
  FileOrchestrationJournal,
  FileRunControl,
  FileRunRepository,
  RunIdSchema,
  UnityWorkConfigV1Schema,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  TestPlayCliAdapter,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
} from "./unity-adapters.js";
import { UnityWorkTransaction } from "./unity-transaction.js";

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "honeybee-unity-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const script = async (
  directory: string,
  name: string,
  lines: readonly string[],
): Promise<string> => {
  const target = path.join(directory, name);
  await writeFile(target, lines.join("\n"), "utf8");
  return target;
};

const parentKey = {
  schemaVersion: 2,
  digest: "a".repeat(64),
  libraryKey: {
    schemaVersion: "1",
    digest: "b".repeat(64),
    unityVersion: "6000.0.0f1",
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
  virtualBytes: 1073741824,
  blockBytes: 2097152,
  sectorBytes: 4096,
} as const;

describe("UnityWorkTransaction", () => {
  it("releases real successful and failed Agent transactions with residual 0", async () => {
    const root = await temporaryDirectory();
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
    ]);

    const storageScript = await script(root, "storage.mjs", [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "const op = args[1];",
      "const root = process.cwd();",
      "const leases = path.join(root, '.fake-leases');",
      "if (op === 'acquire') {",
      "  let input = '';",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => input += chunk);",
      "  process.stdin.on('end', () => {",
      "    const request = JSON.parse(input);",
      "    const workspace = process.cwd();",
      "    fs.mkdirSync(path.join(workspace, 'Library'));",
      "    fs.mkdirSync(path.join(path.dirname(workspace), '.fake-leases'), { recursive: true });",
      "    const leaseId = 'lease-' + request.workspaceId;",
      "    fs.writeFileSync(path.join(path.dirname(workspace), '.fake-leases', leaseId + '.json'), JSON.stringify({ workspace }));",
      "    process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, provider: request.parentKey.provider, lease: { leaseId, runId: request.consumerId, parentKey: request.parentKey.digest, mountPath: path.join(workspace, 'Library'), state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n');",
      "  });",
      "} else if (op === 'release') {",
      "  const leaseId = args[args.indexOf('--lease-id') + 1];",
      "  const requestId = args[args.indexOf('--request-id') + 1];",
      "  const mappingPath = path.join(leases, leaseId + '.json');",
      "  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));",
      "  fs.rmSync(mapping.workspace, { recursive: true, force: true });",
      "  fs.rmSync(mappingPath, { force: true });",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, provider: 'vhdx-differencing', lease: { leaseId, runId: 'released', parentKey: 'released', mountPath: 'released', state: 'released', createdAt: new Date().toISOString(), retained: false }, metrics: { cleanupState: 'released' } }) + '\\n');",
      "} else if (op === 'status') {",
      "  const requestId = args[args.indexOf('--request-id') + 1];",
      "  const active = fs.existsSync(leases) ? fs.readdirSync(leases).length : 0;",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, provider: 'vhdx-differencing', status: { activeChildCount: active, retainedChildCount: 0, pendingCount: 0, quarantineCount: 0 } }) + '\\n');",
      "} else { process.exitCode = 1; }",
    ]);
    const agentScript = await script(root, "agent.mjs", [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const match = input.match(/HONEYBEE_INPUT_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\nHONEYBEE_INPUT_END/u);",
      "  const envelope = JSON.parse(match[1]);",
      "  fs.writeFileSync(path.join(process.cwd(), 'Assets', 'agent-created.txt'), 'workspace only\\n');",
      "  const response = { schemaVersion: 2, runId: envelope.runId, stepId: envelope.step.id, status: 'completed', outputs: { content: { mediaType: 'text/plain; charset=utf-8', content: 'unity change prepared' } } };",
      "  process.stdout.write('HONEYBEE_RESPONSE_BEGIN\\n' + JSON.stringify(response) + '\\nHONEYBEE_RESPONSE_END\\n');",
      "});",
    ]);
    const failingAgentScript = await script(root, "failing-agent.mjs", [
      "process.stdin.resume();",
      "process.stdin.on('end', () => { process.exitCode = 7; });",
    ]);
    const testplayScript = await script(root, "testplay.mjs", [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));",
      "if (!fs.existsSync(path.join(config.project_path, 'Assets', 'agent-created.txt'))) process.exit(3);",
      "const runId = 'fake-run';",
      "const artifactRoot = path.join(config.project_path, '.testplay', 'runs', runId);",
      "fs.mkdirSync(artifactRoot, { recursive: true });",
      "const files = { 'results.xml': '<test-run result=\"Passed\" />\\n', 'summary.json': '{\"passed\":1}\\n', 'manifest.json': '{\"schema_version\":\"1\"}\\n', 'stdout.log': 'passed\\n', 'stderr.log': '', 'events.ndjson': '{\"phase\":\"done\"}\\n' };",
      "for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(artifactRoot, name), content);",
      "process.stdout.write(JSON.stringify({ schema_version: '1', run_id: runId, status: 'passed' }) + '\\n');",
    ]);

    const config = UnityWorkConfigV1Schema.parse({
      schemaVersion: 1,
      sourceProjectPath: source,
      workspaceStorage: {
        command: { command: process.execPath, args: [storageScript] },
        contractCommit: "575c3b37896cd3dfa37a4705477837cc52ec6132",
        binarySha256: createHash("sha256")
          .update(await readFile(process.execPath))
          .digest("hex"),
        workspaceRoot,
        parentKey,
      },
      agent: {
        command: { command: process.execPath, args: [agentScript] },
        harness: "stdio-framed-v2",
        timeoutMs: 10_000,
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
    const executorLease = await controls.acquire(runId);
    const journal = new FileOrchestrationJournal(runRoot);
    try {
      const result = await new UnityWorkTransaction(
        new ChildProcessAgentRunner(),
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
      ).run(runId, "Create a verified Unity change.", config);
      expect(result.status).toBe("completed");
      expect(result.evidence?.kind).toBe("testplay-evidence");
      expect(result.release?.kind).toBe("workspace-release-receipt");
    } finally {
      await executorLease.release();
    }

    await expect(access(path.join(workspaceRoot, "hb-" + runId))).rejects.toBeDefined();
    await expect(access(path.join(source, "Assets", "agent-created.txt"))).rejects.toBeDefined();
    expect(await readFile(path.join(source, "Assets", "Game.cs"), "utf8")).toBe("class Game {}\n");
    const status = await new UnityWorkspaceStorageCliAdapter(
      config.workspaceStorage.command,
      config.workspaceStorage.parentKey.provider,
      config.workspaceStorage.binarySha256,
    ).status("residual-" + runId, workspaceRoot);
    expect(status.status).toMatchObject({
      activeChildCount: 0,
      retainedChildCount: 0,
      pendingCount: 0,
      quarantineCount: 0,
    });
    await expect(
      new UnityWorkspaceStorageCliAdapter(
        config.workspaceStorage.command,
        config.workspaceStorage.parentKey.provider,
        "0".repeat(64),
      ).status("wrong-binary-pin", workspaceRoot),
    ).rejects.toMatchObject({ code: "workspace.protocol-invalid" });
    const replay = await journal.replay(runId);
    expect(replay.status).toBe("terminal");
    if (replay.status === "terminal") {
      expect(replay.terminal.type).toBe("workflow.completed");
      expect(replay.events.at(-2)?.type).toBe("workspace.released");
    }

    const failedRunId = RunIdSchema.parse(randomUUID());
    const failedConfig = UnityWorkConfigV1Schema.parse({
      ...config,
      agent: {
        ...config.agent,
        command: { command: process.execPath, args: [failingAgentScript] },
      },
    });
    await new FileRunRepository(runRoot).create(failedRunId);
    const failedControls = new FileRunControl(runRoot);
    const failedLease = await failedControls.acquire(failedRunId);
    const failedJournal = new FileOrchestrationJournal(runRoot);
    try {
      const failed = await new UnityWorkTransaction(
        new ChildProcessAgentRunner(),
        new FileArtifactStore(runRoot),
        failedJournal,
        failedControls,
        new UnityProjectBootstrap(),
        new UnityWorkspaceStorageCliAdapter(
          failedConfig.workspaceStorage.command,
          failedConfig.workspaceStorage.parentKey.provider,
          failedConfig.workspaceStorage.binarySha256,
        ),
        new TestPlayCliAdapter(failedConfig.testplay),
      ).run(failedRunId, "fail after acquire", failedConfig);
      expect(failed.status).toBe("failed");
      expect(failed.failure?.errorCode).toBe("agent.non-zero-exit");
      expect(failed.release?.kind).toBe("workspace-release-receipt");
    } finally {
      await failedLease.release();
    }
    await expect(access(path.join(workspaceRoot, "hb-" + failedRunId))).rejects.toBeDefined();
    const failedReplay = await failedJournal.replay(failedRunId);
    expect(failedReplay.status).toBe("terminal");
    if (failedReplay.status === "terminal") {
      expect(failedReplay.events.at(-2)?.type).toBe("workspace.released");
      expect(failedReplay.terminal.type).toBe("workflow.failed");
    }
    const finalStatus = await new UnityWorkspaceStorageCliAdapter(
      config.workspaceStorage.command,
      config.workspaceStorage.parentKey.provider,
      config.workspaceStorage.binarySha256,
    ).status("final-residual-" + failedRunId, workspaceRoot);
    expect(finalStatus.status).toMatchObject({
      activeChildCount: 0,
      retainedChildCount: 0,
      pendingCount: 0,
      quarantineCount: 0,
    });
  }, 30_000);
});
