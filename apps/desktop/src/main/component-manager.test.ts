import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DesktopComponentManager, readCompatibilityManifest } from "./component-manager.js";

const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const treeDigest = (relative: string, content: Uint8Array): string => {
  const relativeBytes = Buffer.from(relative, "utf8");
  const frame = Buffer.allocUnsafe(8);
  frame.writeUInt32BE(relativeBytes.byteLength, 0);
  frame.writeUInt32BE(content.byteLength, 4);
  return createHash("sha256")
    .update(frame)
    .update(relativeBytes)
    .update(Buffer.from(digest(content), "hex"))
    .digest("hex");
};

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-components-"));
  const bundled = path.join(root, "bundled");
  await mkdir(bundled);
  const client = Buffer.from("storage-client");
  const host = Buffer.from("storage-host");
  const cli = Buffer.from("testplay-protocol-v3");
  const bridgeArchive = Buffer.from("approved-bridge-archive");
  const bridgePackage = Buffer.from('{"name":"com.testplay.bridge","version":"3"}\n');
  await writeFile(path.join(bundled, "client.exe"), client);
  await writeFile(path.join(bundled, "host.exe"), host);
  const storage = (version: string) => ({
    componentId: "workspace-storage" as const,
    version,
    honeybeeVersion: "0.6.0",
    platform: "win32" as const,
    architecture: "x64" as const,
    payloads: [
      {
        role: "client" as const,
        source: "bundled" as const,
        fileName: "client.exe",
        byteLength: client.byteLength,
        sha256: digest(client),
        archive: "none" as const,
      },
      {
        role: "host" as const,
        source: "bundled" as const,
        fileName: "host.exe",
        byteLength: host.byteLength,
        sha256: digest(host),
        archive: "none" as const,
      },
    ],
  });
  const manifest = {
    schemaVersion: 1 as const,
    honeybeeVersion: "0.6.0",
    workspaceStorage: [storage("1.0.0"), storage("1.1.0")],
    testplay: [
      {
        componentId: "testplay" as const,
        version: "3.0.0",
        honeybeeVersion: "0.6.0",
        platform: "win32" as const,
        architecture: "x64" as const,
        protocolVersion: 3 as const,
        bridgeOverlayDigest: treeDigest("package.json", bridgePackage),
        payloads: [
          {
            role: "cli" as const,
            source: "download" as const,
            fileName: "testplay.exe",
            url: "https://github.com/Kubonsang/testplay-runner/releases/download/v3/testplay.exe",
            byteLength: cli.byteLength,
            sha256: digest(cli),
            archive: "none" as const,
          },
          {
            role: "bridge-overlay" as const,
            source: "download" as const,
            fileName: "bridge.zip",
            url: "https://github.com/Kubonsang/testplay-runner/releases/download/v3/bridge.zip",
            byteLength: bridgeArchive.byteLength,
            sha256: digest(bridgeArchive),
            archive: "zip" as const,
          },
        ],
      },
    ],
  };
  const manager = new DesktopComponentManager(
    path.join(root, "managed"),
    bundled,
    manifest,
    async (url, target) => {
      await writeFile(target, url.endsWith("bridge.zip") ? bridgeArchive : cli);
    },
    async (_archive, destination) => {
      const bridge = path.join(destination, "unity", "com.testplay.bridge");
      await mkdir(bridge, { recursive: true });
      await writeFile(path.join(bridge, "package.json"), bridgePackage);
    },
    path.join(root, "machine", "honeybee-workspace-storage-host.exe"),
  );
  return { root, bundled, manager, manifest, host };
};

describe("DesktopComponentManager", () => {
  it("pins the repository compatibility manifest bytes", async () => {
    const manifest = await readCompatibilityManifest(
      path.resolve("apps", "desktop", "resources", "component-compatibility-v1.json"),
    );
    expect(manifest.workspaceStorage[0]?.version).toBe("0.0.0+e69fb8a0c55c.hb2");
  });

  it("installs immutable storage versions and requires an exact active service lock", async () => {
    const { root, manager, host } = await fixture();
    const first = await manager.installWorkspaceStorage("1.0.0");
    const second = await manager.installWorkspaceStorage("1.1.0");
    expect(first.version).toBe("1.0.0");
    expect(second.version).toBe("1.1.0");

    const firstLock = await manager.lock("workspace-storage", "1.0.0");
    const secondLock = await manager.lock("workspace-storage", "1.1.0");
    await mkdir(path.join(root, "machine"));
    await writeFile(path.join(root, "machine", "honeybee-workspace-storage-host.exe"), host);
    await manager.activateWorkspaceStorage(firstLock.version, "C:\\HoneyBee\\workspaces");
    await expect(manager.assertWorkspaceStorageActive(firstLock)).resolves.toBeUndefined();
    await expect(manager.assertWorkspaceStorageActive(secondLock)).rejects.toThrow(
      "Switch it explicitly",
    );

    const snapshot = await manager.snapshot();
    expect(
      snapshot.installed.filter((receipt) => receipt.componentId === "workspace-storage"),
    ).toHaveLength(2);
    expect(snapshot.activeWorkspaceStorage?.version).toBe("1.0.0");

    await manager.activateWorkspaceStorage(secondLock.version, "C:\\HoneyBee\\workspaces");
    await expect(manager.assertWorkspaceStorageActive(secondLock)).resolves.toBeUndefined();
    await expect(manager.assertWorkspaceStorageActive(firstLock)).rejects.toThrow(
      "Switch it explicitly",
    );
    await writeFile(
      path.join(root, "machine", "honeybee-workspace-storage-host.exe"),
      "unapproved-service",
    );
    await expect(manager.assertWorkspaceStorageActive(secondLock)).rejects.toThrow(
      "Switch it explicitly",
    );
  });

  it("installs a new bundled composite version without rewriting a prior manifest receipt", async () => {
    const { root, bundled, manager, manifest } = await fixture();
    const prior = await manager.ensureBundledWorkspaceStorage();
    const upgradedManifest = {
      ...manifest,
      workspaceStorage: [
        {
          ...manifest.workspaceStorage[0],
          version: "1.0.0+hb1",
        },
      ],
    };
    const upgraded = new DesktopComponentManager(
      path.join(root, "managed"),
      bundled,
      upgradedManifest,
    );

    await expect(upgraded.ensureBundledWorkspaceStorage()).resolves.toMatchObject({
      version: "1.0.0+hb1",
    });
    await expect(
      readFile(path.join(path.dirname(prior.files[0]?.path ?? ""), "receipt.json")),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(upgraded.snapshot()).resolves.toMatchObject({
      installed: [{ version: "1.0.0+hb1" }],
    });
  });

  it("installs only approved TestPlay CLI and Bridge bundles after approval", async () => {
    const { manager } = await fixture();
    await expect(manager.installTestPlay("3.0.0", false)).rejects.toThrow("explicit approval");
    const receipt = await manager.installTestPlay("3.0.0", true);
    expect(receipt.files.map((file) => file.role).sort()).toEqual(["bridge-overlay", "cli"]);
    expect(
      await readFile(receipt.files.find((file) => file.role === "cli")?.path ?? "", "utf8"),
    ).toBe("testplay-protocol-v3");
    await expect(manager.installTestPlay("9.9.9", true)).rejects.toThrow("not approved");
  });

  it("fails closed when installed bytes no longer match the exact project lock", async () => {
    const { manager } = await fixture();
    const receipt = await manager.installWorkspaceStorage("1.0.0");
    const lock = await manager.lock("workspace-storage", "1.0.0");
    const client = receipt.files.find((file) => file.role === "client");
    if (client === undefined) throw new Error("missing client");
    await writeFile(client.path, "tampered");
    await expect(manager.assertLock(lock)).rejects.toThrow("integrity");
  });
});
