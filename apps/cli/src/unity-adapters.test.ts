import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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

const command = async (mode: "malformed" | "rejected" | "wrong-provider") => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-storage-contract-"));
  directories.push(root);
  const script = path.join(root, "storage.mjs");
  await writeFile(
    script,
    [
      "import path from 'node:path';",
      "const mode = process.argv[2];",
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);",
      "process.stdin.on('end', () => {",
      " if (mode === 'malformed') { process.stdout.write('not-json\\n'); return; }",
      " if (mode === 'rejected') { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, operation: 'acquire', error: { code: 'workspace-command-failed', message: 'rejected' } }) + '\\n'); process.exitCode = 1; return; }",
      " const request = JSON.parse(input); process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, provider: 'wrong', lease: { leaseId: 'lease', runId: request.consumerId, parentKey: request.parentKey.digest, mountPath: path.join(process.cwd(), 'Library'), state: 'ready', createdAt: new Date().toISOString(), retained: false } }) + '\\n');",
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
});
