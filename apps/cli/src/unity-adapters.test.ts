import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ContentDigestSchema, RunIdSchema, StepIdSchema } from "@honeybee/core";

import {
  TestPlayCliAdapter,
  UnityAgentProcessRunner,
  UnityProjectBootstrap,
  UnityWorkspaceStorageCliAdapter,
  type WorkspaceAcquireRequest,
} from "./unity-adapters.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const command = async (
  mode:
    | "case-mount"
    | "mount"
    | "mount-with-lock"
    | "mount-with-lock-directory"
    | "malformed"
    | "rejected"
    | "wrong-provider",
) => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-storage-contract-"));
  directories.push(root);
  const script = path.join(root, "storage.mjs");
  await writeFile(
    script,
    [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const mode = process.argv[2];",
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);",
      "process.stdin.on('end', () => {",
      " if (mode === 'malformed') { process.stdout.write('not-json\\n'); return; }",
      " if (mode === 'rejected') { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, operation: 'acquire', error: { code: 'workspace-command-failed', message: 'rejected' } }) + '\\n'); process.exitCode = 1; return; }",
      " const request = JSON.parse(input); const library = path.join(process.cwd(), 'Library'); const mounted = mode === 'case-mount' || mode.startsWith('mount'); if (mounted) fs.mkdirSync(library); if (mode === 'mount-with-lock') fs.writeFileSync(path.join(library, 'SourceAssetDB-lock'), 'stale'); if (mode === 'mount-with-lock-directory') fs.mkdirSync(path.join(library, 'SourceAssetDB-lock')); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, provider: mounted ? request.parentKey.provider : 'wrong', lease: { leaseId: 'lease', runId: request.consumerId, parentKey: request.parentKey.digest, mountPath: mode === 'case-mount' ? library.toUpperCase() : library, state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n');",
      "});",
    ].join("\n"),
    "utf8",
  );
  const sha256 = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  const executor: NonNullable<
    ConstructorParameters<typeof UnityWorkspaceStorageCliAdapter>[3]
  > = async (_configuredCommand, _args, options) => {
    let stdout: string;
    let exitCode = 0;
    if (mode === "malformed") stdout = "not-json\n";
    else if (mode === "rejected") {
      stdout =
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          operation: "acquire",
          error: { code: "workspace-command-failed", message: "rejected" },
        }) + "\n";
      exitCode = 1;
    } else {
      const parsed = JSON.parse(options.input ?? "{}") as WorkspaceAcquireRequest;
      const library = path.join(options.cwd, "Library");
      const mounted = mode === "case-mount" || mode.startsWith("mount");
      if (mounted) await mkdir(library);
      if (mode === "mount-with-lock")
        await writeFile(path.join(library, "SourceAssetDB-lock"), "stale", "utf8");
      if (mode === "mount-with-lock-directory")
        await mkdir(path.join(library, "SourceAssetDB-lock"));
      stdout =
        JSON.stringify({
          schemaVersion: 1,
          requestId: parsed.requestId,
          provider: mounted ? parsed.parentKey.provider : "wrong",
          lease: {
            leaseId: "lease",
            runId: parsed.consumerId,
            parentKey: parsed.parentKey.digest,
            mountPath: mode === "case-mount" ? library.toUpperCase() : library,
            state: "ready",
            createdAt: new Date().toISOString(),
            retained: false,
          },
        }) + "\n";
    }
    return {
      pid: process.pid,
      exitCode,
      signal: null,
      durationMs: 1,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      stdoutDigest: ContentDigestSchema.parse(
        "sha256:" + createHash("sha256").update(stdout).digest("hex"),
      ),
      stderrDigest: ContentDigestSchema.parse(
        "sha256:" + createHash("sha256").update("").digest("hex"),
      ),
      termination: "exited",
      stdout,
      stderr: "",
    };
  };
  return {
    root,
    executor,
    adapter: new UnityWorkspaceStorageCliAdapter(
      { command: process.execPath },
      "vhdx-differencing",
      sha256,
      executor,
    ),
  };
};

const request = (): WorkspaceAcquireRequest => ({
  schemaVersion: 1,
  requestId: "request-1",
  consumerId: "consumer-1",
  workspaceId: "workspace-1",
  parentKey: {
    schemaVersion: 2,
    digest: "a".repeat(64),
    libraryKey: {
      schemaVersion: "1",
      digest: "b".repeat(64),
      unityVersion: "6000",
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
    virtualBytes: 1,
    blockBytes: 1,
    sectorBytes: 1,
  },
  clientPid: process.pid,
});

describe("UnityWorkspaceStorageCliAdapter", () => {
  it.each([
    ["malformed", "workspace.command-ambiguous"],
    ["rejected", "workspace.command-failed"],
    ["wrong-provider", "workspace.protocol-invalid"],
  ] as const)("fails closed for %s acquire responses", async (mode, code) => {
    const fixture = await command(mode);
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(workspace);
    await expect(fixture.adapter.acquire(request(), workspace)).rejects.toMatchObject({ code });
  });

  it("refuses bootstrap cleanup when a provider ownership marker exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-bootstrap-contract-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".testplay-vhdx-workspace-owner.json"), "{}", "utf8");
    await expect(
      new UnityProjectBootstrap().cleanupUnacquired(root, "workspace"),
    ).rejects.toMatchObject({ code: "workspace.cleanup-unsafe" });
  });

  it.skipIf(process.platform !== "win32")(
    "accepts a broker mount path whose Windows casing differs",
    async () => {
      const fixture = await command("case-mount");
      const workspace = path.join(fixture.root, "workspace");
      await mkdir(workspace);
      await expect(fixture.adapter.acquire(request(), workspace)).resolves.toMatchObject({
        lease: { leaseId: "lease" },
      });
    },
  );

  it("removes only the stale SourceAssetDB lock from an acquired child", async () => {
    const fixture = await command("mount-with-lock");
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(workspace);
    await expect(fixture.adapter.acquire(request(), workspace)).resolves.toMatchObject({
      lease: { leaseId: "lease" },
    });
    await expect(access(path.join(workspace, "Library", "SourceAssetDB-lock"))).rejects.toThrow();
  });

  it("accepts an acquired child whose SourceAssetDB lock is already absent", async () => {
    const fixture = await command("mount");
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(workspace);
    await expect(fixture.adapter.acquire(request(), workspace)).resolves.toMatchObject({
      lease: { leaseId: "lease" },
    });
  });

  it("refuses to remove a non-file SourceAssetDB lock", async () => {
    const fixture = await command("mount-with-lock-directory");
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(workspace);
    await expect(fixture.adapter.acquire(request(), workspace)).rejects.toMatchObject({
      code: "workspace.protocol-invalid",
    });
    await expect(access(path.join(workspace, "Library", "SourceAssetDB-lock"))).resolves.toBe(
      undefined,
    );
  });

  it("revalidates the pinned storage executable before every invocation", async () => {
    const fixture = await command("wrong-provider");
    const pinnedBinary = path.join(fixture.root, "node-copy.exe");
    await copyFile(process.execPath, pinnedBinary);
    const sha256 = createHash("sha256")
      .update(await readFile(pinnedBinary))
      .digest("hex");
    const adapter = new UnityWorkspaceStorageCliAdapter(
      { command: pinnedBinary },
      "vhdx-differencing",
      sha256,
      fixture.executor,
    );
    await adapter.preflight();
    await appendFile(pinnedBinary, "replaced-after-preflight", "utf8");
    await expect(
      adapter.acquire(request(), path.join(fixture.root, "workspace")),
    ).rejects.toMatchObject({ code: "workspace.protocol-invalid" });
  });

  it("rejects unpinned storage arguments and environment injection", async () => {
    const sha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    for (const configured of [
      { command: process.execPath, args: ["storage.mjs"] },
      { command: process.execPath, env: { NODE_OPTIONS: "--require=storage.cjs" } },
    ]) {
      await expect(
        new UnityWorkspaceStorageCliAdapter(configured, "vhdx-differencing", sha256).preflight(),
      ).rejects.toMatchObject({ code: "workspace.protocol-invalid" });
    }
  });
});

describe("UnityProjectBootstrap source manifests", () => {
  const project = async (
    root: string,
    files: Readonly<Record<string, string>>,
  ): Promise<string> => {
    await Promise.all(
      ["Assets", "Packages", "ProjectSettings"].map((name) =>
        mkdir(path.join(root, name), { recursive: true }),
      ),
    );
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(path.join(root, "Assets", name), content, "utf8"),
      ),
    );
    return root;
  };

  it("frames each path and content so ambiguous trees cannot share a digest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-manifest-framing-"));
    directories.push(root);
    const first = await project(path.join(root, "first"), { a: "Xb", b: "Y", cc: "Z" });
    const second = await project(path.join(root, "second"), { a: "X", bb: "Yc", c: "Z" });

    const [firstManifest, secondManifest] = await Promise.all([
      new UnityProjectBootstrap().manifest(first),
      new UnityProjectBootstrap().manifest(second),
    ]);

    expect(firstManifest.fileCount).toBe(secondManifest.fileCount);
    expect(firstManifest.logicalBytes).toBe(secondManifest.logicalBytes);
    expect(firstManifest.assetsDigest).not.toBe(secondManifest.assetsDigest);
    expect(firstManifest.digest).not.toBe(secondManifest.digest);
  });
});

describe("TestPlayCliAdapter filesystem safety", () => {
  const adapter = (root: string) =>
    new TestPlayCliAdapter({
      command: { command: "unused" },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 10_000,
    });

  it("refuses to replace a hard link at the reserved TestPlay config path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-config-link-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const victim = path.join(root, "victim.json");
    const runId = RunIdSchema.parse(randomUUID());
    await mkdir(workspace);
    await writeFile(victim, "do not overwrite", "utf8");
    await link(victim, path.join(workspace, ".honeybee-testplay-" + runId + ".json"));

    await expect(
      adapter(root).run(runId, workspace, new AbortController().signal, {
        onStarted: async () => undefined,
        onExited: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "workspace.cleanup-unsafe" });
    expect(await readFile(victim, "utf8")).toBe("do not overwrite");
  });

  it("rejects an Evidence file larger than the per-file byte budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-evidence-file-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const evidenceRoot = path.join(workspace, ".testplay", "runs", "run");
    await mkdir(evidenceRoot, { recursive: true });
    const evidencePath = path.join(evidenceRoot, "stdout.log");
    await writeFile(evidencePath, "");
    await truncate(evidencePath, 16 * 1024 * 1024 + 1);

    await expect(adapter(root).recoverEvidence(workspace)).rejects.toMatchObject({
      code: "testplay.failed",
    });
  });

  it("rejects aggregate Evidence larger than the transaction byte budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-evidence-total-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const evidenceRoot = path.join(workspace, ".testplay", "runs", "run");
    await mkdir(evidenceRoot, { recursive: true });
    await Promise.all(
      ["results.xml", "stdout.log", "stderr.log"].map(async (name) => {
        const target = path.join(evidenceRoot, name);
        await writeFile(target, "");
        await truncate(target, 12 * 1024 * 1024);
      }),
    );

    await expect(adapter(root).recoverEvidence(workspace)).rejects.toMatchObject({
      code: "testplay.failed",
    });
  });
});

describe("TestPlayCliAdapter process control", () => {
  it("does not start TestPlay before its durable start registration completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-start-barrier-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "executed");
    const script = path.join(root, "testplay.mjs");
    await mkdir(workspace);
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');",
      "utf8",
    );
    const adapter = new TestPlayCliAdapter({
      command: { command: process.execPath, args: [script, marker] },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 10_000,
    });

    await expect(
      adapter.run(RunIdSchema.parse(randomUUID()), workspace, new AbortController().signal, {
        onStarted: async () => {
          throw new Error("injected journal failure");
        },
        onExited: async () => undefined,
      }),
    ).rejects.toThrow("injected journal failure");
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("does not start TestPlay before containment registration is durable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-register-barrier-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "executed");
    const script = path.join(root, "testplay.mjs");
    await mkdir(workspace);
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');",
      "utf8",
    );
    const adapter = new TestPlayCliAdapter({
      command: { command: process.execPath, args: [script, marker] },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 10_000,
    });

    await expect(
      adapter.run(RunIdSchema.parse(randomUUID()), workspace, new AbortController().signal, {
        onStarted: async () => undefined,
        onRegistered: async () => {
          throw new Error("injected registration journal failure");
        },
        onExited: async () => undefined,
      }),
    ).rejects.toThrow("injected registration journal failure");
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("keeps target NODE_OPTIONS out of the containment launcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-env-barrier-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const preloadMarker = path.join(root, "preload-ran");
    const preload = path.join(root, "target-preload.cjs");
    const script = path.join(root, "testplay.cjs");
    await mkdir(workspace);
    await writeFile(
      preload,
      "require('node:fs').writeFileSync(process.env.HONEYBEE_PRELOAD_MARKER, 'loaded');",
      "utf8",
    );
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify({ run_id: 'env-test', total: 1 }) + '\\n');",
      "utf8",
    );
    const adapter = new TestPlayCliAdapter({
      command: {
        command: process.execPath,
        args: [script],
        env: {
          NODE_OPTIONS: "--require=" + preload,
          HONEYBEE_PRELOAD_MARKER: preloadMarker,
        },
      },
      unityPath: path.join(root, "Unity.exe"),
      platform: "edit_mode",
      timeoutMs: 10_000,
    });
    let started = false;

    const result = await adapter.run(
      RunIdSchema.parse(randomUUID()),
      workspace,
      new AbortController().signal,
      {
        onStarted: async (_pid, metadata) => {
          started = true;
          expect(metadata?.containment).toBe("deferred-v1");
          await expect(access(preloadMarker)).rejects.toBeDefined();
        },
        onRegistered: async () => undefined,
        onExited: async () => undefined,
      },
    );

    expect(started).toBe(true);
    expect(result.command.exitCode).toBe(0);
    expect(await readFile(preloadMarker, "utf8")).toBe("loaded");
  });

  it.skipIf(process.platform !== "win32")(
    "terminates the complete TestPlay process tree before reporting cancellation",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "honeybee-testplay-tree-"));
      directories.push(root);
      const workspace = path.join(root, "workspace");
      const script = path.join(root, "testplay-wrapper.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      await mkdir(workspace);
      await writeFile(
        script,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "process.stdin.resume();",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
          "child.once('spawn', () => writeFileSync(process.argv[2], String(child.pid)));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      const adapter = new TestPlayCliAdapter({
        command: { command: process.execPath, args: [script, grandchildPidPath] },
        unityPath: path.join(root, "Unity.exe"),
        platform: "edit_mode",
        timeoutMs: 20_000,
      });
      const aborter = new AbortController();
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;
      let exitPersisted = false;
      try {
        const execution = adapter.run(RunIdSchema.parse(randomUUID()), workspace, aborter.signal, {
          onStarted: async (pid) => {
            parentPid = pid;
          },
          onExited: async () => {
            exitPersisted = true;
          },
        });
        for (let attempt = 0; attempt < 100 && grandchildPid === undefined; attempt += 1) {
          try {
            grandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(grandchildPid).toBeGreaterThan(0);
        aborter.abort();

        const result = await execution;

        expect(result.command.termination).toBe("cancelled");
        expect(exitPersisted).toBe(true);
        expect(() => process.kill(grandchildPid as number, 0)).toThrow();
      } finally {
        for (const pid of [grandchildPid, parentPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already terminated by the adapter.
          }
        }
      }
    },
    30_000,
  );
});

describe("UnityAgentProcessRunner process control", () => {
  it("does not start the Agent before its durable start registration completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-start-barrier-"));
    directories.push(root);
    const marker = path.join(root, "executed");
    const script = path.join(root, "agent.mjs");
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');",
      "utf8",
    );

    await expect(
      new UnityAgentProcessRunner().run(
        {
          runId: RunIdSchema.parse(randomUUID()),
          stepId: StepIdSchema.parse("unity-agent"),
          prompt: "work",
          command: { command: process.execPath, args: [script, marker], cwd: root },
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
        },
        {
          onStarted: async () => {
            throw new Error("injected journal failure");
          },
          onExited: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "agent.spawn-failed" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("does not start the Agent before containment registration is durable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-register-barrier-"));
    directories.push(root);
    const marker = path.join(root, "executed");
    const script = path.join(root, "agent.mjs");
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');",
      "utf8",
    );

    await expect(
      new UnityAgentProcessRunner().run(
        {
          runId: RunIdSchema.parse(randomUUID()),
          stepId: StepIdSchema.parse("unity-agent"),
          prompt: "work",
          command: { command: process.execPath, args: [script, marker], cwd: root },
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
        },
        {
          onStarted: async () => undefined,
          onRegistered: async () => {
            throw new Error("injected registration journal failure");
          },
          onExited: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "agent.spawn-failed" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("does not report a target exit when cancellation drains an unregistered launcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-unregistered-cancel-"));
    directories.push(root);
    const marker = path.join(root, "executed");
    const script = path.join(root, "agent.mjs");
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');",
      "utf8",
    );
    const aborter = new AbortController();
    let releaseStart: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let registered = false;
    let exited = false;
    const execution = new UnityAgentProcessRunner().run(
      {
        runId: RunIdSchema.parse(randomUUID()),
        stepId: StepIdSchema.parse("unity-agent"),
        prompt: "work",
        command: { command: process.execPath, args: [script, marker], cwd: root },
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        signal: aborter.signal,
      },
      {
        onStarted: async () => {
          startedResolve?.();
          await startGate;
        },
        onRegistered: async () => {
          registered = true;
        },
        onExited: async () => {
          exited = true;
        },
      },
    );
    await started;
    aborter.abort();
    releaseStart?.();

    const result = await execution;

    expect(result.termination).toBe("cancelled");
    expect(registered).toBe(false);
    expect(exited).toBe(false);
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("keeps target NODE_OPTIONS out of the containment launcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-env-barrier-"));
    directories.push(root);
    const preloadMarker = path.join(root, "preload-ran");
    const preload = path.join(root, "target-preload.cjs");
    const script = path.join(root, "agent.cjs");
    await writeFile(
      preload,
      "require('node:fs').writeFileSync(process.env.HONEYBEE_PRELOAD_MARKER, 'loaded');",
      "utf8",
    );
    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('HONEYBEE_RESPONSE_BEGIN\\n' + JSON.stringify({",
        "    schemaVersion: 2,",
        "    runId: process.env.HONEYBEE_RUN_ID,",
        "    stepId: process.env.HONEYBEE_STEP_ID,",
        "    status: 'completed',",
        "    outputs: { content: { mediaType: 'text/plain; charset=utf-8', content: 'done' } }",
        "  }) + '\\nHONEYBEE_RESPONSE_END\\n');",
        "});",
      ].join("\n"),
      "utf8",
    );
    let started = false;
    const result = await new UnityAgentProcessRunner().run(
      {
        runId: RunIdSchema.parse(randomUUID()),
        stepId: StepIdSchema.parse("unity-agent"),
        prompt: "work",
        command: {
          command: process.execPath,
          args: [script],
          cwd: root,
          env: {
            NODE_OPTIONS: "--require=" + preload,
            HONEYBEE_PRELOAD_MARKER: preloadMarker,
          },
        },
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
      },
      {
        onStarted: async (_pid, metadata) => {
          started = true;
          expect(metadata?.containment).toBe("deferred-v1");
          await expect(access(preloadMarker)).rejects.toBeDefined();
        },
        onRegistered: async () => undefined,
        onExited: async () => undefined,
      },
    );

    expect(started).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(await readFile(preloadMarker, "utf8")).toBe("loaded");
  });

  it.skipIf(process.platform !== "win32")(
    "terminates the complete Agent process tree before reporting cancellation",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "honeybee-unity-agent-tree-"));
      directories.push(root);
      const script = path.join(root, "agent-wrapper.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      await writeFile(
        script,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "process.stdin.resume();",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
          "child.once('spawn', () => writeFileSync(process.argv[2], String(child.pid)));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      const aborter = new AbortController();
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;
      let exitPersisted = false;
      try {
        const execution = new UnityAgentProcessRunner().run(
          {
            runId: RunIdSchema.parse(randomUUID()),
            stepId: StepIdSchema.parse("unity-agent"),
            prompt: "work",
            command: { command: process.execPath, args: [script, grandchildPidPath], cwd: root },
            timeoutMs: 20_000,
            maxOutputBytes: 1024 * 1024,
            signal: aborter.signal,
          },
          {
            onStarted: async (pid) => {
              parentPid = pid;
            },
            onExited: async () => {
              exitPersisted = true;
            },
          },
        );
        for (let attempt = 0; attempt < 100 && grandchildPid === undefined; attempt += 1) {
          try {
            grandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(grandchildPid).toBeGreaterThan(0);
        aborter.abort();

        const result = await execution;

        expect(result.termination).toBe("cancelled");
        expect(exitPersisted).toBe(true);
        expect(() => process.kill(grandchildPid as number, 0)).toThrow();
      } finally {
        for (const pid of [grandchildPid, parentPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already terminated by the runner.
          }
        }
      }
    },
    30_000,
  );
});
