import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

const latestRoot = (): string => {
  const root = roots.at(-1);
  if (root === undefined) throw new Error("A temporary Agent root was not created.");
  return root;
};

describe("DesktopAgentManager", () => {
  it("probes a custom CLI without reading or storing credentials", async () => {
    const settings = await store();
    const manager = new DesktopAgentManager(settings);
    const profile = await manager.upsert({
      schemaVersion: 1,
      displayName: "Node fixture",
      provider: "custom",
      command: { command: process.execPath },
      enabled: true,
    });
    const status = await manager.probe(profile);
    expect(status).toMatchObject({ agentId: profile.agentId, status: "ready" });
    expect(status.version).toContain("v");
  });

  it("reports disabled profiles without starting a process", async () => {
    const settings = await store();
    const manager = new DesktopAgentManager(settings);
    const profile = await settings.upsertAgent({
      schemaVersion: 1,
      displayName: "Disabled",
      provider: "custom",
      command: { command: "must-not-run" },
      enabled: false,
    });
    const status = await manager.probe(profile);
    expect(status.status).toBe("disabled");
  });

  it("delegates custom authentication outside HoneyBee", async () => {
    const settings = await store();
    const manager = new DesktopAgentManager(settings);
    const profile = await manager.upsert({
      schemaVersion: 1,
      displayName: "Custom",
      provider: "custom",
      command: { command: process.execPath },
      enabled: true,
    });
    const result = await manager.connect(profile);
    expect(result).toMatchObject({ launched: false, agentId: profile.agentId });
  });

  it("fails closed when an approved custom payload changes", async () => {
    const settings = await store();
    const payload = path.join(latestRoot(), "agent-payload.js");
    await writeFile(payload, "export {};\n", "utf8");
    const manager = new DesktopAgentManager(settings);
    const profile = await manager.upsert({
      schemaVersion: 1,
      displayName: "Pinned payload",
      provider: "custom",
      command: { command: process.execPath },
      payloadPaths: [payload],
      enabled: true,
    });
    expect((await manager.probe(profile)).status).toBe("ready");
    await writeFile(payload, "export const changed = true;\n", "utf8");
    expect((await manager.probe(profile)).status).toBe("trust-changed");
  });

  it("pins the payload behind a Windows npm-style command shim", async () => {
    const settings = await store();
    const directory = latestRoot();
    const shim = path.join(directory, "fixture.cmd");
    const payload = path.join(directory, "fixture.exe");
    await writeFile(payload, "fixture payload", "utf8");
    await writeFile(shim, '@echo off\r\n"%dp0%\\fixture.exe" %*\r\n', "utf8");
    const profile = await new DesktopAgentManager(settings).upsert({
      schemaVersion: 1,
      displayName: "Shim fixture",
      provider: "custom",
      command: { command: shim },
      enabled: true,
    });
    const [canonicalShim, canonicalPayload] = await Promise.all([
      realpath(shim),
      realpath(payload),
    ]);
    expect(profile.trust?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "entrypoint", path: canonicalShim }),
        expect.objectContaining({ role: "payload", path: canonicalPayload }),
      ]),
    );
  });

  it.runIf(process.platform === "win32")(
    "probes a pinned npm-style command shim without invoking cmd.exe",
    async () => {
      const settings = await store();
      const directory = latestRoot();
      const shim = path.join(directory, "fixture.cmd");
      const payload = path.join(directory, "fixture.js");
      const extra = path.join(directory, "extra-payload.js");
      await writeFile(
        payload,
        "if (process.argv.includes('--version')) process.stdout.write('fixture 1.0.0\\n');\n",
        "utf8",
      );
      await writeFile(extra, "export {};\n", "utf8");
      await writeFile(shim, '@echo off\r\nnode "%dp0%\\fixture.js" %*\r\n', "utf8");
      const shadowDirectory = path.join(directory, "shadow-bin");
      const decoyDirectory = path.join(directory, "decoy-bin");
      await mkdir(shadowDirectory);
      await mkdir(decoyDirectory);
      await writeFile(path.join(shadowDirectory, "node.cmd"), "@exit /b 1\r\n", "utf8");
      await writeFile(path.join(decoyDirectory, "node.exe"), "not an executable", "utf8");
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = `${shadowDirectory}${path.delimiter}${previousPath ?? ""}`;
        const manager = new DesktopAgentManager(settings);
        const profile = await manager.upsert({
          schemaVersion: 1,
          displayName: "Runnable shim fixture",
          provider: "custom",
          command: { command: shim },
          payloadPaths: [extra],
          enabled: true,
        });
        expect(profile.trust?.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "interpreter",
              path: expect.stringMatching(/node\.exe$/iu),
            }),
          ]),
        );
        process.env.PATH = `${decoyDirectory}${path.delimiter}${previousPath ?? ""}`;
        await expect(manager.probe(profile)).resolves.toMatchObject({
          status: "ready",
          version: "fixture 1.0.0",
        });
        expect(profile.command.command).toBe(path.resolve(shim));
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );
});
