import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RunIdSchema } from "@honeybee/core";

import {
  TestPlayCliAdapter,
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

const command = async (mode: "case-mount" | "malformed" | "rejected" | "wrong-provider") => {
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
      " const request = JSON.parse(input); const library = path.join(process.cwd(), 'Library'); if (mode === 'case-mount') fs.mkdirSync(library); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, provider: mode === 'case-mount' ? request.parentKey.provider : 'wrong', lease: { leaseId: 'lease', runId: request.consumerId, parentKey: request.parentKey.digest, mountPath: mode === 'case-mount' ? library.toUpperCase() : library, state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n');",
      "});",
    ].join("\n"),
    "utf8",
  );
  const sha256 = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  return {
    root,
    adapter: new UnityWorkspaceStorageCliAdapter(
      { command: process.execPath, args: [script, mode] },
      "vhdx-differencing",
      sha256,
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

  it("revalidates the pinned storage executable before every invocation", async () => {
    const fixture = await command("wrong-provider");
    const pinnedBinary = path.join(fixture.root, "node-copy.exe");
    await copyFile(process.execPath, pinnedBinary);
    const sha256 = createHash("sha256")
      .update(await readFile(pinnedBinary))
      .digest("hex");
    const adapter = new UnityWorkspaceStorageCliAdapter(
      {
        command: pinnedBinary,
        args: [path.join(fixture.root, "storage.mjs"), "wrong-provider"],
      },
      "vhdx-differencing",
      sha256,
    );
    await adapter.preflight();
    await appendFile(pinnedBinary, "replaced-after-preflight", "utf8");
    await expect(
      adapter.acquire(request(), path.join(fixture.root, "workspace")),
    ).rejects.toMatchObject({ code: "workspace.protocol-invalid" });
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

describe("TestPlayCliAdapter process control", () => {
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
      let exitedAfterTreeDrain = false;
      try {
        const execution = adapter.run(RunIdSchema.parse(randomUUID()), workspace, aborter.signal, {
          onStarted: async (pid) => {
            parentPid = pid;
          },
          onExited: async () => {
            exitedAfterTreeDrain =
              grandchildPid !== undefined &&
              (() => {
                try {
                  process.kill(grandchildPid as number, 0);
                  return false;
                } catch {
                  return true;
                }
              })();
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
        expect(exitedAfterTreeDrain).toBe(true);
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
