import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  NativeAgentHostActivationV1Schema,
  NativeAgentHostLaunchIntentV1Schema,
} from "@honeybee/orchestration-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SystemNativeAgentHost, newNativeAgentLaunchIdentity } from "./native-agent-host.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hostSource = path.join(repositoryRoot, "tools", "native-agent-host");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = async (filePath: string): Promise<string> =>
  `sha256:${createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex")}`;

const build = async (target: string, output: string): Promise<void> => {
  await execFileAsync(
    "go",
    ["build", "-buildvcs=false", "-trimpath", "-ldflags=-buildid=", "-o", output, target],
    {
      cwd: hostSource,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64", GOWORK: "off" },
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
};

describe.skipIf(process.platform !== "win32")("SystemNativeAgentHost integration", () => {
  it("verifies both durable receipts before activating a real provider process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-host-e2e-"));
    roots.push(root);
    const hostExecutable = path.join(root, "host.exe");
    const providerExecutable = path.join(root, "provider.exe");
    await Promise.all([
      build(".", hostExecutable),
      build("./testdata/fake-provider", providerExecutable),
    ]);
    const controller = new SystemNativeAgentHost(path.join(root, "state"));
    const identity = newNativeAgentLaunchIdentity();
    const receiptDirectory = await controller.launchDirectory(identity.launchId);
    const marker = path.join(root, "provider.started");
    const intent = NativeAgentHostLaunchIntentV1Schema.parse({
      schemaVersion: 1,
      launchId: identity.launchId,
      nonce: identity.nonce,
      ownerRunId: randomUUID(),
      workspaceId: "cross-language-workspace",
      providerId: "codex",
      priority: "interactive",
      receiptDirectory,
      hostExecutablePath: hostExecutable,
      hostExecutableDigest: await digest(hostExecutable),
      registrationTimeoutMs: 15_000,
      activationTimeoutMs: 15_000,
      shutdownTimeoutMs: 15_000,
      createdAt: new Date().toISOString(),
    });
    const activation = NativeAgentHostActivationV1Schema.parse({
      schemaVersion: 1,
      launchId: intent.launchId,
      nonce: intent.nonce,
      providerId: intent.providerId,
      command: {
        command: providerExecutable,
        env: { HONEYBEE_FAKE_MARKER: marker, HONEYBEE_FAKE_WAIT_MS: "100" },
      },
      executableDigest: await digest(providerExecutable),
    });
    const observed: string[] = [];
    const handle = await controller.launch(intent, activation, {
      onHostRegistered: async () => {
        observed.push("host");
      },
      onProcessRegistered: async () => {
        observed.push("process");
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      },
      onActivated: async () => {
        observed.push("activated");
      },
    });
    const receipt = await handle.completion;
    expect(observed).toEqual(["host", "process", "activated"]);
    expect(receipt).toMatchObject({ termination: "exited", descendantsDrained: true });
    await expect(stat(marker)).resolves.toMatchObject({ size: 8 });
    await expect(controller.inspect(intent)).resolves.toMatchObject({
      phase: "exited",
      occupied: false,
    });
  }, 60_000);

  it("durably cancels when launch finalization fails after the provider resumes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-host-cleanup-e2e-"));
    roots.push(root);
    const hostExecutable = path.join(root, "host.exe");
    const providerExecutable = path.join(root, "provider.exe");
    await Promise.all([
      build(".", hostExecutable),
      build("./testdata/fake-provider", providerExecutable),
    ]);
    const controller = new SystemNativeAgentHost(path.join(root, "state"));
    const identity = newNativeAgentLaunchIdentity();
    const receiptDirectory = await controller.launchDirectory(identity.launchId);
    const intent = NativeAgentHostLaunchIntentV1Schema.parse({
      schemaVersion: 1,
      launchId: identity.launchId,
      nonce: identity.nonce,
      ownerRunId: randomUUID(),
      workspaceId: "late-activation-cleanup",
      providerId: "codex",
      priority: "interactive",
      receiptDirectory,
      hostExecutablePath: hostExecutable,
      hostExecutableDigest: await digest(hostExecutable),
      registrationTimeoutMs: 15_000,
      activationTimeoutMs: 15_000,
      shutdownTimeoutMs: 15_000,
      createdAt: new Date().toISOString(),
    });
    const activation = NativeAgentHostActivationV1Schema.parse({
      schemaVersion: 1,
      launchId: intent.launchId,
      nonce: intent.nonce,
      providerId: intent.providerId,
      command: {
        command: providerExecutable,
        env: {
          HONEYBEE_FAKE_MARKER: path.join(root, "provider.started"),
          HONEYBEE_FAKE_WAIT_MS: "30000",
        },
      },
      executableDigest: await digest(providerExecutable),
    });

    await expect(
      controller.launch(intent, activation, {
        onHostRegistered: async () => undefined,
        onProcessRegistered: async () => undefined,
        onActivated: async () => {
          throw new Error("late activation finalization failed");
        },
      }),
    ).rejects.toThrow("late activation finalization failed");
    await expect(controller.inspect(intent)).resolves.toMatchObject({
      phase: "exited",
      occupied: false,
    });
  }, 60_000);
});
