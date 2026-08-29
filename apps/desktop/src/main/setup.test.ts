import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopSetupCoordinator, computeUnityCompatibility } from "./setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-setup-key-"));
  roots.push(root);
  const project = path.join(root, "project");
  const overlay = path.join(root, "bridge");
  const unity = path.join(root, "Unity.exe");
  const testplay = path.join(root, "testplay.exe");
  const storage = path.join(root, "unity-workspace-storage.exe");
  const storageHost = path.join(root, "honeybee-workspace-storage-host.exe");
  const agent = path.join(root, "opencode.exe");
  const workspace = path.join(root, "workspaces");
  const setupRoot = path.join(root, "setups");
  for (const directory of [
    path.join(project, "Assets"),
    path.join(project, "Packages"),
    path.join(project, "ProjectSettings"),
    overlay,
    workspace,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(project, "Assets", "Game.cs"), "class Game {}\n");
  await writeFile(path.join(project, "Packages", "manifest.json"), '{"dependencies":{}}\n');
  await writeFile(path.join(project, "Packages", "packages-lock.json"), '{"dependencies":{}}\n');
  await writeFile(
    path.join(project, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.8f1\n",
  );
  await writeFile(
    path.join(project, "ProjectSettings", "ProjectSettings.asset"),
    "scriptingBackend: 1\n",
  );
  await writeFile(path.join(overlay, "package.json"), '{"name":"com.testplay.bridge"}\n');
  await writeFile(unity, "unity-v1");
  await writeFile(testplay, "testplay-v1");
  await writeFile(storage, "storage-v1");
  await writeFile(storageHost, "storage-host-v1");
  await writeFile(agent, "agent-v1");
  return {
    root,
    project,
    overlay,
    unity,
    testplay,
    storage,
    storageHost,
    agent,
    workspace,
    setupRoot,
  };
};

const fileLock = async (
  role: "client" | "host",
  target: string,
): Promise<{
  role: "client" | "host";
  path: string;
  kind: "file";
  byteLength: number;
  sha256: string;
}> => ({
  role,
  path: target,
  kind: "file",
  byteLength: (await stat(target)).size,
  sha256: createHash("sha256")
    .update(await readFile(target))
    .digest("hex"),
});

const waitForTerminal = async (coordinator: DesktopSetupCoordinator, setupId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await coordinator.status(setupId);
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Setup did not reach a terminal state.");
};

const storageResult = (value: Record<string, unknown>) => {
  const stdout = JSON.stringify(value) + "\n";
  return { pid: process.pid, exitCode: 0, signal: null, stdout, stderr: "" } as const;
};

describe("managed Unity compatibility", () => {
  it("reuses a parent across ordinary Assets changes", async () => {
    const { project, overlay, unity } = await fixture();
    const before = await computeUnityCompatibility(project, unity, overlay);
    await writeFile(path.join(project, "Assets", "Game.cs"), "class Game { int Value; }\n");
    const after = await computeUnityCompatibility(project, unity, overlay);
    expect(after.compatibilityKey).toBe(before.compatibilityKey);
    expect(after.inputs).toEqual(before.inputs);
  });

  it("invalidates reuse for Packages, required settings, Unity, and Bridge changes", async () => {
    const cases: ReadonlyArray<(paths: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = [
      ({ project }) =>
        writeFile(path.join(project, "Packages", "manifest.json"), '{"dependencies":{"x":"1"}}\n'),
      ({ project }) =>
        writeFile(
          path.join(project, "ProjectSettings", "ProjectSettings.asset"),
          "scriptingBackend: 0\n",
        ),
      ({ unity }) => writeFile(unity, "unity-v2"),
      ({ overlay }) =>
        writeFile(
          path.join(overlay, "package.json"),
          '{"name":"com.testplay.bridge","version":"2"}\n',
        ),
    ];
    for (const mutate of cases) {
      const nextFixture = await fixture();
      const freshBaseline = await computeUnityCompatibility(
        nextFixture.project,
        nextFixture.unity,
        nextFixture.overlay,
      );
      await mutate(nextFixture);
      const changed = await computeUnityCompatibility(
        nextFixture.project,
        nextFixture.unity,
        nextFixture.overlay,
      );
      expect(changed.compatibilityKey).not.toBe(freshBaseline.compatibilityKey);
    }
  });

  it("prepares an Agent-only parent without TestPlay or a Bridge overlay", async () => {
    const paths = await fixture();
    const projectRoot = path.join(paths.workspace, "schema2-parent-test");
    const library = path.join(projectRoot, "Library");
    let shellObserved = false;
    const processContainment: ConstructorParameters<typeof DesktopSetupCoordinator>[2] = {
      captureIdentity: async () => "process-created-at-test",
      drain: async () => "drained",
      run: async (_request, lifecycle) => {
        await lifecycle.onStarted?.(process.pid, { containment: "deferred-v1" });
        await lifecycle.onRegistered?.(process.pid);
        shellObserved =
          (await readFile(path.join(projectRoot, "Assets", "Game.cs"), "utf8")) ===
          "class Game {}\n";
        await writeFile(path.join(library, "ArtifactDB"), "populated");
        const observation = {
          pid: process.pid,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
        } as const;
        await lifecycle.onExited?.(observation);
        return { ...observation, stdout: "", stderr: "", termination: "exited" };
      },
    };
    const execute: ConstructorParameters<typeof DesktopSetupCoordinator>[3] = async (
      _command,
      args,
    ) => {
      if (args[0] === "parent" && args[1] === "begin") {
        await mkdir(library, { recursive: true });
        return storageResult({
          schemaVersion: 2,
          requestId: args[args.indexOf("--request-id") + 1],
          ok: true,
          provider: "vhdx-differencing",
          transactionId: "parent-transaction",
          stagingPath: library,
        });
      }
      if (args[0] === "parent" && args[1] === "commit") {
        await rm(library, { recursive: true });
        return storageResult({
          schemaVersion: 2,
          requestId: args[args.indexOf("--request-id") + 1],
          ok: true,
          provider: "vhdx-differencing",
          parent: {
            parentId: "parent-managed",
            compatibilityKey: (await computeUnityCompatibility(paths.project, paths.unity))
              .compatibilityKey,
            provider: "vhdx-differencing",
            immutable: true,
          },
        });
      }
      throw new Error("Unexpected storage command: " + args.join(" "));
    };
    const profiles: unknown[] = [];
    const coordinator = new DesktopSetupCoordinator(
      paths.setupRoot,
      async (profile) => {
        profiles.push(profile);
      },
      processContainment,
      execute,
    );
    const started = await coordinator.start({
      schemaVersion: 1,
      label: "Managed game",
      projectPath: paths.project,
      unityPath: paths.unity,
      workspaceStoragePath: paths.storage,
      workspaceRoot: paths.workspace,
      agent: { command: paths.agent },
      editorCapacity: 2,
      componentLocks: {
        workspaceStorage: {
          schemaVersion: 1,
          componentId: "workspace-storage",
          version: "1.0.0",
          receiptDigest: "a".repeat(64),
          files: [
            await fileLock("client", paths.storage),
            await fileLock("host", paths.storageHost),
          ],
        },
      },
    });
    const terminal = await waitForTerminal(coordinator, started.setupId);
    expect(terminal.state).toBe("completed");
    expect(shellObserved).toBe(true);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toHaveProperty("schemaVersion", 3);
    expect(profiles[0]).toHaveProperty("environment.storage.component.version", "1.0.0");
    expect(profiles[0]).not.toHaveProperty("environment.testplay");
    expect(profiles[0]).not.toHaveProperty("environment.bridgeOverlay");
    await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(paths.project, "Packages", "com.testplay.bridge")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an ambiguous cancelled parent begin and aborts it before finishing", async () => {
    const paths = await fixture();
    const projectRoot = path.join(paths.workspace, "schema2-parent-cancelled");
    const library = path.join(projectRoot, "Library");
    const beginRequestIds: string[] = [];
    let notifyBegin!: () => void;
    const beginStarted = new Promise<void>((resolve) => {
      notifyBegin = resolve;
    });
    let beginCalls = 0;
    const execute: ConstructorParameters<typeof DesktopSetupCoordinator>[3] = async (
      _command,
      args,
      options,
    ) => {
      const requestId = args[args.indexOf("--request-id") + 1] ?? "";
      if (args[0] === "parent" && args[1] === "begin") {
        beginCalls += 1;
        beginRequestIds.push(requestId);
        if (beginCalls === 1) {
          await mkdir(library, { recursive: true });
          notifyBegin();
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          });
        }
        return storageResult({
          schemaVersion: 2,
          requestId,
          ok: true,
          provider: "vhdx-differencing",
          transactionId: "cancelled-parent-transaction",
          stagingPath: library,
        });
      }
      if (args[0] === "parent" && args[1] === "abort") {
        await rm(library, { recursive: true });
        return storageResult({
          schemaVersion: 2,
          requestId,
          ok: true,
          provider: "vhdx-differencing",
        });
      }
      throw new Error("Unexpected storage command: " + args.join(" "));
    };
    const coordinator = new DesktopSetupCoordinator(
      paths.setupRoot,
      async () => undefined,
      undefined,
      execute,
    );
    const started = await coordinator.start({
      schemaVersion: 1,
      label: "Cancelled game",
      projectPath: paths.project,
      unityPath: paths.unity,
      testplayPath: paths.testplay,
      workspaceStoragePath: paths.storage,
      workspaceRoot: paths.workspace,
      bridgeOverlayPath: paths.overlay,
      agent: { command: paths.agent },
      editorCapacity: 1,
    });
    await beginStarted;
    await coordinator.cancel(started.setupId);
    const terminal = await waitForTerminal(coordinator, started.setupId);
    expect(terminal.state).toBe("cancelled");
    expect(beginRequestIds).toEqual([beginRequestIds[0], beginRequestIds[0]]);
    await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
