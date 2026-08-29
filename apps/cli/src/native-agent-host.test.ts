import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NativeAgentHostLaunchIntentV1Schema,
  type NativeAgentHostLaunchIntentV1,
} from "@honeybee/orchestration-contracts";
import { describe, expect, it } from "vitest";

import { publishImmutableJson } from "./immutable-publication.js";
import {
  NativeAgentCapacityIndex,
  SystemNativeAgentHost,
  type NativeAgentAdmissionCandidate,
} from "./native-agent-host.js";
import type { UnityProcessControl } from "./process-control.js";

class FakeProcesses implements UnityProcessControl {
  readonly identities = new Map<number, string>();

  public captureIdentity(pid: number): Promise<string | undefined> {
    return Promise.resolve(this.identities.get(pid));
  }

  public drain(): Promise<"drained"> {
    return Promise.resolve("drained");
  }
}

const makeIntent = async (
  host: SystemNativeAgentHost,
  priority: NativeAgentHostLaunchIntentV1["priority"] = "validation",
  createdAt = new Date().toISOString(),
): Promise<NativeAgentHostLaunchIntentV1> => {
  const launchId = randomUUID();
  const receiptDirectory = await host.launchDirectory(launchId);
  const intent = NativeAgentHostLaunchIntentV1Schema.parse({
    schemaVersion: 1,
    launchId,
    nonce: "a".repeat(64),
    ownerRunId: randomUUID(),
    workspaceId: `workspace-${launchId}`,
    providerId: "codex",
    priority,
    receiptDirectory,
    hostExecutablePath: path.join(receiptDirectory, "host.exe"),
    hostExecutableDigest: `sha256:${"b".repeat(64)}`,
    registrationTimeoutMs: 30_000,
    activationTimeoutMs: 30_000,
    shutdownTimeoutMs: 30_000,
    createdAt,
  });
  await publishImmutableJson(path.join(receiptDirectory, "intent.json"), intent);
  return intent;
};

const publishActiveHost = async (
  intent: NativeAgentHostLaunchIntentV1,
  pid: number,
  identity: string,
): Promise<void> => {
  await publishImmutableJson(path.join(intent.receiptDirectory, "host-receipt.json"), {
    schemaVersion: 1,
    launchId: intent.launchId,
    nonce: intent.nonce,
    hostPid: pid,
    processIdentity: identity,
    containmentProtocol: "native-agent-host-v1",
    workspaceId: intent.workspaceId,
    publishedAt: new Date().toISOString(),
  });
};

describe("NativeAgentCapacityIndex", () => {
  it("reconstructs four occupied launches from receipts after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-capacity-"));
    const processes = new FakeProcesses();
    const host = new SystemNativeAgentHost(root, processes);
    for (let index = 0; index < 4; index += 1) {
      const intent = await makeIntent(host);
      const pid = 1000 + index;
      const identity = `win32:${pid}`;
      processes.identities.set(pid, identity);
      await publishActiveHost(intent, pid, identity);
    }

    const restarted = new NativeAgentCapacityIndex(
      new SystemNativeAgentHost(root, processes),
      root,
      4,
    );
    expect((await restarted.reconstruct()).filter((entry) => entry.occupied)).toHaveLength(4);
    expect(
      await restarted.select([
        { id: "fifth", priority: "interactive", createdAt: new Date().toISOString() },
      ]),
    ).toEqual([]);
  });

  it("selects priority first and FIFO within the same priority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-priority-"));
    const host = new SystemNativeAgentHost(root, new FakeProcesses());
    const index = new NativeAgentCapacityIndex(host, root, 3);
    const candidates: NativeAgentAdmissionCandidate[] = [
      { id: "background", priority: "background", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "interactive-new", priority: "interactive", createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "interactive-old", priority: "interactive", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "validation", priority: "validation", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect((await index.select(candidates)).map((candidate) => candidate.id)).toEqual([
      "interactive-old",
      "interactive-new",
      "validation",
    ]);
  });

  it("durably abandons an intent whose Host never registered", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-abandon-"));
    const host = new SystemNativeAgentHost(root, new FakeProcesses());
    const intent = await makeIntent(host, "validation", "2020-01-01T00:00:00.000Z");
    const first = await host.inspect(intent);
    const replayed = await host.inspect(intent);
    expect(first).toMatchObject({ phase: "abandoned-before-registration", occupied: false });
    expect(replayed).toMatchObject({ phase: "abandoned-before-registration", occupied: false });
  });
});
