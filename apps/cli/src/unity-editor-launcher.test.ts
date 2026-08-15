import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ContentDigestSchema,
  EditorContainmentReceiptV1Schema,
  EditorLaunchIntentV1Schema,
} from "@honeybee/core";
import { afterEach, describe, expect, it } from "vitest";

import { SystemUnityEditorLauncher } from "./unity-editor-launcher.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-launcher-"));
  roots.push(root);
  const projectPath = path.join(root, "project");
  const receiptDirectory = path.join(root, "run", "control");
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(receiptDirectory, { recursive: true }),
  ]);
  const digest = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  const launchId = randomUUID();
  return {
    intent: EditorLaunchIntentV1Schema.parse({
      schemaVersion: 1,
      launchId,
      nonce: randomBytes(32).toString("hex"),
      poolId: "unity-editors",
      slotId: "editor-1",
      poolLeaseId: randomUUID(),
      ownerRunId: randomUUID(),
      ownerWorkId: "work-a",
      workspaceId: "hb-work",
      projectPath,
      unityExecutablePath: process.execPath,
      unityExecutableDigest: `sha256:${digest}`,
      containmentReceiptPath: path.join(receiptDirectory, `editor-${launchId}.json`),
      registrationTimeoutMs: 120_000,
      activationTimeoutMs: 120_000,
      shutdownTimeoutMs: 120_000,
    }),
  };
};

describe("SystemUnityEditorLauncher", () => {
  it("requires the launcher-published durable receipt before activation and ownership", async () => {
    const { intent } = await fixture();
    const order: string[] = [];
    const launcher = new SystemUnityEditorLauncher();
    const handle = await launcher.launch(
      intent,
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: intent.projectPath,
      },
      {
        onContainmentReady: async (receipt) => {
          const disk = EditorContainmentReceiptV1Schema.parse(
            JSON.parse(await readFile(intent.containmentReceiptPath, "utf8")) as unknown,
          );
          expect(disk).toEqual(receipt);
          expect(receipt.launchId).toBe(intent.launchId);
          expect(receipt.nonce).toBe(intent.nonce);
          order.push("receipt");
        },
        onActivated: async () => {
          order.push("activated");
        },
        onEditorStarted: async () => {
          order.push("owned");
        },
      },
    );
    expect(order).toEqual(["receipt", "activated", "owned"]);
    expect(handle.containment.launchId).toBe(intent.launchId);
    await handle.stop();
  }, 240_000);

  it("rejects a command whose binary digest differs from the durable intent", async () => {
    const { intent } = await fixture();
    const launcher = new SystemUnityEditorLauncher();
    await expect(
      launcher.launch(
        { ...intent, unityExecutableDigest: ContentDigestSchema.parse(`sha256:${"0".repeat(64)}`) },
        { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        {
          onContainmentReady: async () => undefined,
          onActivated: async () => undefined,
          onEditorStarted: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "editor.receipt-invalid" });
  });

  it("rejects an intermediate filesystem link below the trusted state root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-editor-launcher-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "honeybee-editor-launcher-outside-"));
    roots.push(root, outside);
    const projectPath = path.join(root, "project");
    const ownerRunId = randomUUID();
    const runDirectory = path.join(root, ownerRunId);
    await Promise.all([
      mkdir(projectPath),
      mkdir(runDirectory, { recursive: true }),
      mkdir(path.join(outside, "control")),
    ]);
    await symlink(
      path.join(outside, "control"),
      path.join(runDirectory, "control"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const launchId = randomUUID();
    const executableDigest = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const intent = EditorLaunchIntentV1Schema.parse({
      schemaVersion: 1,
      launchId,
      nonce: randomBytes(32).toString("hex"),
      poolId: "unity-editors",
      slotId: "editor-1",
      poolLeaseId: randomUUID(),
      ownerRunId,
      ownerWorkId: "work-a",
      workspaceId: "hb-work",
      projectPath,
      unityExecutablePath: process.execPath,
      unityExecutableDigest: "sha256:" + executableDigest,
      containmentReceiptPath: path.join(runDirectory, "control", "editor-" + launchId + ".json"),
      registrationTimeoutMs: 1000,
      activationTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    });

    await expect(
      new SystemUnityEditorLauncher(root).launch(
        intent,
        { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        {
          onContainmentReady: async () => undefined,
          onActivated: async () => undefined,
          onEditorStarted: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "editor.receipt-invalid" });
  });
});
