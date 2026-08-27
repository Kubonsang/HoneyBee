import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NativeAgentActivationReceiptV1Schema,
  NativeAgentExitReceiptV1Schema,
  NativeAgentHostActivationV1Schema,
  NativeAgentHostLaunchIntentV1Schema,
} from "./native-agent-host.js";

const launchId = randomUUID();
const nonce = "a".repeat(64);

describe("Native Agent Host contracts", () => {
  it("keeps command and environment out of the durable launch intent", () => {
    const intent = {
      schemaVersion: 1,
      launchId,
      nonce,
      ownerRunId: randomUUID(),
      workspaceId: "workspace-test",
      providerId: "codex",
      priority: "interactive",
      receiptDirectory: "C:\\state\\run\\control\\native\\launch",
      hostExecutablePath: "C:\\HoneyBee\\honeybee-native-agent-host.exe",
      hostExecutableDigest: `sha256:${"b".repeat(64)}`,
      registrationTimeoutMs: 30_000,
      activationTimeoutMs: 30_000,
      shutdownTimeoutMs: 120_000,
      createdAt: new Date().toISOString(),
    };
    expect(NativeAgentHostLaunchIntentV1Schema.parse(intent)).toEqual(intent);
    expect(() =>
      NativeAgentHostLaunchIntentV1Schema.parse({
        ...intent,
        command: { command: "codex", env: { SECRET: "value" } },
      }),
    ).toThrow();
  });

  it("accepts provider command only on the volatile activation boundary", () => {
    expect(
      NativeAgentHostActivationV1Schema.parse({
        schemaVersion: 1,
        launchId,
        nonce,
        providerId: "codex",
        command: {
          command: "C:\\Tools\\codex.exe",
          args: [],
          cwd: "C:\\workspace",
          env: { PROVIDER_VALUE: "private" },
        },
        executableDigest: `sha256:${"c".repeat(64)}`,
      }).command.env,
    ).toEqual({ PROVIDER_VALUE: "private" });
  });

  it("requires bootstrap release proof before accepting activation", () => {
    const receipt = {
      schemaVersion: 1,
      launchId,
      nonce,
      targetPid: 123,
      processIdentity: "win32:1234",
      bootstrapKillOnCloseCleared: true,
      bootstrapJobHandleClosed: true,
      activatedAt: new Date().toISOString(),
    };
    expect(NativeAgentActivationReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(() =>
      NativeAgentActivationReceiptV1Schema.parse({
        ...receipt,
        bootstrapJobHandleClosed: false,
      }),
    ).toThrow();
  });

  it("requires target PID and incarnation as one correlated pair", () => {
    expect(() =>
      NativeAgentExitReceiptV1Schema.parse({
        schemaVersion: 1,
        launchId,
        nonce,
        hostPid: 100,
        hostProcessIdentity: "win32:1",
        targetPid: 200,
        exitCode: null,
        termination: "host-failed",
        descendantsDrained: true,
        exitedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});
