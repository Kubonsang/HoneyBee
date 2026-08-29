import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopDogfoodController } from "./desktop-dogfood.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-desktop-dogfood-"));
  roots.push(root);
  return root;
};

const startInput = () => ({
  profileId: randomUUID(),
  projectLabel: "Game",
  projectPath: "C:\\Game",
  configPath: "C:\\Game\\honeybee.json",
  doctorPassed: true,
});

const emptyObservation = {
  runs: [],
  editors: [],
  pool: { active: [], queued: [] },
} as const;

const artifact = async (stateRoot: string, runId: string, kind: string, value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const hex = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(stateRoot, runId, "blobs", "sha256", hex.slice(0, 2), hex.slice(2));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return {
    artifactId: randomUUID(),
    kind,
    mediaType: "application/json",
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${hex}`,
  };
};

const journal = async (stateRoot: string, runId: string, events: readonly unknown[]) => {
  const directory = path.join(stateRoot, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
};

const event = (
  runId: string,
  sequence: number,
  timestamp: string,
  type: string,
  payload: unknown,
) => ({ schemaVersion: 5, eventId: randomUUID(), runId, sequence, timestamp, type, payload });

describe("DesktopDogfoodController", () => {
  it("persists one explicit recording and reconnects after Desktop restart", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "runtime", "runs");
    const first = new DesktopDogfoodController(root, stateRoot);
    const started = await first.start(startInput());
    expect(started.state).toBe("recording");
    await expect(first.start(startInput())).rejects.toThrow("already active");

    const recovered = await new DesktopDogfoodController(root, stateRoot).status(true);
    expect(recovered).toMatchObject({
      state: "recording",
      session: { sessionId: started.session?.sessionId },
    });
  });

  it("requires Doctor success before opening a recording", async () => {
    const root = await temporaryRoot();
    const controller = new DesktopDogfoodController(root, path.join(root, "runs"));
    await expect(controller.start({ ...startInput(), doctorPassed: false })).rejects.toThrow(
      "Doctor must pass",
    );
  });

  it("retains the recorded project and config paths for finalization", async () => {
    const root = await temporaryRoot();
    const controller = new DesktopDogfoodController(root, path.join(root, "runs"));
    const input = startInput();
    const started = await controller.start(input);

    await expect(
      controller.finalizationTarget(started.session?.sessionId as string),
    ).resolves.toEqual({
      projectPath: path.resolve(input.projectPath),
      configPath: path.resolve(input.configPath),
    });
  });

  it("advances the timing window when an incomplete finalization is refreshed", async () => {
    vi.useFakeTimers();
    const root = await temporaryRoot();
    const controller = new DesktopDogfoodController(root, path.join(root, "runs"));
    const input = startInput();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const started = await controller.start(input);
    const parentRunId = randomUUID();
    await controller.recordParentRun(input.profileId, parentRunId, 1);
    const sessionId = started.session?.sessionId as string;

    vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    const first = await controller.finalize({
      sessionId,
      observation: {
        ...emptyObservation,
        runs: [{ runId: parentRunId, status: "running", terminal: false }],
      },
    });
    expect(first.session).toMatchObject({
      stoppedAt: "2026-01-01T01:00:00.000Z",
      summary: { sessionWallClockMs: 3_600_000 },
    });

    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    const refreshed = await controller.finalize({ sessionId, observation: emptyObservation });
    expect(refreshed.session).toMatchObject({
      stoppedAt: "2026-01-01T02:00:00.000Z",
      summary: { sessionWallClockMs: 7_200_000 },
    });
  });

  it("finalizes missing or active work fail-closed and writes idempotent Evidence", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "runtime", "runs");
    const controller = new DesktopDogfoodController(root, stateRoot);
    const input = startInput();
    const started = await controller.start(input);
    const parentRunId = randomUUID();
    await controller.recordParentRun(input.profileId, parentRunId, 2);
    const sessionId = started.session?.sessionId;
    expect(sessionId).toBeDefined();

    const first = await controller.finalize({
      sessionId: sessionId as string,
      observation: {
        ...emptyObservation,
        runs: [{ runId: parentRunId, status: "running", terminal: false }],
      },
    });
    expect(first.state).toBe("incomplete");
    expect(first.session?.summary).toMatchObject({
      verdict: "incomplete",
      workCount: 0,
      residualTotal: 1,
    });

    const second = await controller.finalize({
      sessionId: sessionId as string,
      observation: emptyObservation,
    });
    expect(second.state).toBe("incomplete");
    const evidencePath = second.session?.evidencePath as string;
    const metrics = JSON.parse(await readFile(path.join(evidencePath, "metrics.json"), "utf8"));
    expect(metrics).toMatchObject({ schemaVersion: 1, sessionId, verdict: "incomplete" });
    expect(await readFile(path.join(evidencePath, "summary.md"), "utf8")).toContain("INCOMPLETE");
  });

  it("measures overlapping Agent-only Works without requiring TestPlay", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "runtime", "runs");
    const controller = new DesktopDogfoodController(root, stateRoot);
    const input = startInput();
    const started = await controller.start(input);
    const parentRunId = randomUUID();
    const children = [randomUUID(), randomUUID()];
    await controller.recordParentRun(input.profileId, parentRunId, children.length);
    await journal(stateRoot, parentRunId, [
      event(parentRunId, 1, "2026-01-01T00:00:00.000Z", "workflow.started", {
        mode: "unity-batch-v2",
      }),
      event(parentRunId, 2, "2026-01-01T00:00:07.000Z", "workflow.completed", {}),
    ]);

    for (const [index, runId] of children.entries()) {
      const config = await artifact(stateRoot, runId, "unity-work-config", {
        schemaVersion: 2,
        sourceProjectPath: input.projectPath,
        workspaceStorage: { workspaceRoot: path.join(root, "workspaces") },
        capabilities: [],
      });
      const patch = await artifact(stateRoot, runId, "verified-patch", {
        schemaVersion: 3,
        entries: [{ path: `Assets/Work${index}.cs`, operation: "add" }],
      });
      const offset = index + 1;
      await journal(stateRoot, runId, [
        event(runId, 1, `2026-01-01T00:00:0${offset}.000Z`, "workflow.started", {
          mode: "unity-work-v3",
          config,
          linkage: { parentRunId, workId: `work-${index}`, priority: "validation" },
        }),
        event(runId, 2, `2026-01-01T00:00:0${offset}.000Z`, "agent.started", { pid: 100 + index }),
        event(runId, 3, `2026-01-01T00:00:0${5 - index}.000Z`, "agent.exited", { exitCode: 0 }),
        event(runId, 4, "2026-01-01T00:00:05.500Z", "source.checked", { unchanged: true }),
        event(runId, 5, "2026-01-01T00:00:06.000Z", "patch.verified", { patch }),
        event(runId, 6, "2026-01-01T00:00:06.100Z", "workflow.completed", {}),
      ]);
      await writeFile(
        path.join(stateRoot, runId, "patch-disposition.json"),
        JSON.stringify({
          runId,
          action: "apply",
          phase: "applied",
          startedAt: "2026-01-01T00:00:06.000Z",
          updatedAt: "2026-01-01T00:00:06.050Z",
          conflictPaths: [],
        }),
        "utf8",
      );
    }

    const result = await controller.finalize({
      sessionId: started.session?.sessionId as string,
      observation: {
        ...emptyObservation,
        runs: [
          { runId: parentRunId, status: "completed", terminal: true },
          ...children.map((runId) => ({
            runId,
            parentRunId,
            status: "completed",
            terminal: true,
          })),
        ],
      },
    });
    expect(result.state).toBe("passed");
    expect(result.session?.summary).toMatchObject({
      verdict: "passed",
      workCount: 2,
      completedWorks: 2,
      changedFiles: 2,
      testCount: 0,
      maxConcurrentAgents: 2,
      agentOverlapMs: 2_000,
      residualTotal: 0,
    });
  });
});
