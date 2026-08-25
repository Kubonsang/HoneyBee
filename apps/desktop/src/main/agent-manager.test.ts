import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopAgentManager } from "./agent-manager.js";
import { DesktopSettingsStore } from "./settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const store = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-agent-manager-"));
  roots.push(root);
  return new DesktopSettingsStore(root);
};

describe("DesktopAgentManager", () => {
  it("probes a custom CLI without reading or storing credentials", async () => {
    const settings = await store();
    const profile = await settings.upsertAgent({
      schemaVersion: 1,
      displayName: "Node fixture",
      provider: "custom",
      command: { command: process.execPath },
      enabled: true,
    });
    const status = await new DesktopAgentManager(settings).probe(profile);
    expect(status).toMatchObject({ agentId: profile.agentId, status: "ready" });
    expect(status.version).toContain("v");
  });

  it("reports disabled profiles without starting a process", async () => {
    const settings = await store();
    const profile = await settings.upsertAgent({
      schemaVersion: 1,
      displayName: "Disabled",
      provider: "custom",
      command: { command: "must-not-run" },
      enabled: false,
    });
    const status = await new DesktopAgentManager(settings).probe(profile);
    expect(status.status).toBe("disabled");
  });

  it("delegates custom authentication outside HoneyBee", async () => {
    const settings = await store();
    const profile = await settings.upsertAgent({
      schemaVersion: 1,
      displayName: "Custom",
      provider: "custom",
      command: { command: process.execPath },
      enabled: true,
    });
    const result = await new DesktopAgentManager(settings).connect(profile);
    expect(result).toMatchObject({ launched: false, agentId: profile.agentId });
  });
});
