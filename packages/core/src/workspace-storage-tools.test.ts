import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));

import { WindowsWorkspaceStorage } from "./workspace-storage.js";
import { WorkspaceToolResolver } from "./workspace-tool-resolution.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  execute.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("dispatches client and control calls to the same pinned pair despite environment changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-storage-dispatch-"));
  roots.push(root);
  const clientCommand = path.join(root, "client.exe");
  const controlCommand = path.join(root, "custom-host.exe");
  await writeFile(clientCommand, "client");
  await writeFile(controlCommand, "host");
  const pair = new WorkspaceToolResolver({
    explicit: { clientCommand, controlCommand },
  }).resolve(process.execPath);
  vi.stubEnv("HONEYBEE_WORKSPACE_STORAGE_CONTROL", path.join(root, "wrong-host.exe"));
  execute.mockImplementation((_command, _args, _options, callback) => {
    callback(
      null,
      JSON.stringify({
        ok: true,
        parent: { parentId: "parent" },
        diagnostic: {},
        status: { parentCount: 0, manualRecoveryRequired: false },
      }),
      "",
    );
    return { stdin: { end: vi.fn() } };
  });
  const storage = new WindowsWorkspaceStorage();
  await storage.commitParent(pair, "transaction");
  await storage.retain(pair, "lease");
  await storage.diagnose(pair);
  await storage.status(pair);
  expect(execute.mock.calls.map(([command]) => command)).toEqual([
    clientCommand,
    controlCommand,
    controlCommand,
    clientCommand,
  ]);
});

it.each([
  {},
  { parentCount: -1, manualRecoveryRequired: false },
  { parentCount: 1.5, manualRecoveryRequired: false },
  { parentCount: 0 },
  { parentCount: 0, manualRecoveryRequired: "false" },
])("rejects malformed status instead of assuming an empty healthy store: %j", async (status) => {
  execute.mockImplementation((_command, _args, _options, callback) => {
    callback(null, JSON.stringify({ ok: true, status }), "");
    return { stdin: { end: vi.fn() } };
  });
  await expect(new WindowsWorkspaceStorage().status(process.execPath)).rejects.toThrow(
    "Storage status is incomplete or invalid",
  );
});
const validEvidence = () => ({
  schemaVersion: 1,
  recoveryReady: false,
  receiptSha256: "a".repeat(64),
  configSha256: "b".repeat(64),
  executableSha256: "c".repeat(64),
  receipt: {
    schemaVersion: 2,
    serviceName: "UnityWorkspaceStorage",
    pipeName: "pipe",
    componentVersion: "source.hb12",
    storeRoot: "C:\\store",
    workspaceRoot: "C:\\workspaces",
    configPath: "C:\\store\\broker-config.json",
    executable: "C:\\store\\broker\\unity-workspace-storage-host.exe",
    executableSha256: "c".repeat(64),
    userSid: "S-1-5-21-1",
  },
  scm: {
    command: "broker command",
    account: "LocalSystem",
    startType: 2,
    serviceType: 16,
    state: "running",
  },
});
it("queries evidence through the pinned control executable without backup or elevation arguments", async () => {
  const evidence = validEvidence();
  execute.mockImplementation((_command, _args, _options, callback) => {
    callback(null, JSON.stringify({ schemaVersion: 1, ok: true, evidence }), "");
    return { stdin: { end: vi.fn() } };
  });
  const pair = {
    provenance: "explicit" as const,
    clientCommand: process.execPath,
    controlCommand: process.execPath,
  };
  expect(await new WindowsWorkspaceStorage().serviceEvidence(pair)).toEqual(evidence);
  expect(execute.mock.calls[0]?.slice(0, 2)).toEqual([process.execPath, ["service-evidence"]]);
});
it.each([
  "missing",
  "schema",
  "recovery-authority",
  "hash",
  "account",
  "state",
  "receipt-schema",
  "relative-path",
  "digest-disagreement",
  "failed-command",
  "invalid-json",
])("rejects invalid service evidence: %s", async (kind) => {
  const evidence = validEvidence();
  const response: Record<string, unknown> = { schemaVersion: 1, ok: true, evidence };
  if (kind === "missing") delete response.evidence;
  if (kind === "schema") response.schemaVersion = 2;
  if (kind === "recovery-authority") evidence.recoveryReady = true;
  if (kind === "hash") evidence.configSha256 = "bad";
  if (kind === "account") evidence.scm.account = "other-user";
  if (kind === "state") evidence.scm.state = "stopped";
  if (kind === "receipt-schema") evidence.receipt.schemaVersion = 1;
  if (kind === "relative-path") evidence.receipt.storeRoot = "relative";
  if (kind === "digest-disagreement") evidence.receipt.executableSha256 = "d".repeat(64);
  if (kind === "failed-command") response.ok = false;
  execute.mockImplementation((_command, _args, _options, callback) => {
    callback(null, kind === "invalid-json" ? "broken" : JSON.stringify(response), "");
    return { stdin: { end: vi.fn() } };
  });
  await expect(
    new WindowsWorkspaceStorage().serviceEvidence({
      provenance: "explicit",
      clientCommand: process.execPath,
      controlCommand: process.execPath,
    }),
  ).rejects.toThrow();
});
