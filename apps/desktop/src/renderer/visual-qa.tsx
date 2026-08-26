import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DesktopRuntimeSnapshotV1Schema, type HoneyBeeDesktopApi } from "../shared/ipc.js";
import { App } from "./App.js";
import "./styles.css";
import "./dashboard.css";

const projectId = "11111111-1111-4111-8111-111111111111";
const agentId = "12121212-1212-4212-8212-121212121212";
const runA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runDone = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const now = new Date();
const timestamp = (secondsAgo: number) =>
  new Date(now.getTime() - secondsAgo * 1_000).toISOString();

const summaries = [
  {
    schemaVersion: 1 as const,
    runId: runA,
    journalSchemaVersion: 5,
    mode: "unity-editor-work",
    status: "running",
    phase: "agent.running",
    startedAt: timestamp(1_120),
    updatedAt: timestamp(18),
    terminal: false,
    executorPresent: true,
    projectPath: "C:\\Unity\\MyUnityGame",
    workId: "inventory-stack",
    priority: "interactive" as const,
    assignedEditor: "editor-1",
    allowedActions: ["cancel" as const],
  },
  {
    schemaVersion: 1 as const,
    runId: runB,
    journalSchemaVersion: 5,
    mode: "unity-editor-work",
    status: "queued",
    phase: "waiting-for-editor",
    startedAt: timestamp(560),
    updatedAt: timestamp(34),
    terminal: false,
    executorPresent: true,
    projectPath: "C:\\Unity\\MyUnityGame",
    workId: "movement-jitter",
    priority: "validation" as const,
    allowedActions: ["cancel" as const],
  },
  {
    schemaVersion: 1 as const,
    runId: runC,
    journalSchemaVersion: 5,
    mode: "unity-editor-work",
    status: "running",
    phase: "warm-test.running",
    startedAt: timestamp(1_925),
    updatedAt: timestamp(8),
    terminal: false,
    executorPresent: true,
    projectPath: "C:\\Unity\\MyUnityGame",
    workId: "save-load",
    priority: "background" as const,
    assignedEditor: "editor-2",
    allowedActions: ["cancel" as const],
  },
  {
    schemaVersion: 1 as const,
    runId: runDone,
    journalSchemaVersion: 5,
    mode: "unity-editor-work",
    status: "completed",
    phase: "workflow.completed",
    startedAt: timestamp(3_100),
    updatedAt: timestamp(47),
    terminal: true,
    executorPresent: false,
    projectPath: "C:\\Unity\\MyUnityGame",
    workId: "action-bar-feedback",
    priority: "validation" as const,
    assignedEditor: "editor-2",
    allowedActions: [],
  },
];

const snapshot = DesktopRuntimeSnapshotV1Schema.parse({
  schemaVersion: 1 as const,
  observedAt: timestamp(0),
  runs: summaries,
  editors: {
    schemaVersion: 1 as const,
    editors: [
      {
        schemaVersion: 1 as const,
        editorId: "10101010-1010-4010-8010-101010101010",
        pid: 12345,
        processIdentity: "12345:fixture-a",
        projectPath: "C:\\HoneyBee\\workspaces\\inventory-stack",
        workspaceId: "workspace-a",
        ownership: "honeybee" as const,
        ownerRunId: runA,
        ownerWorkId: "inventory-stack",
        slotId: "editor-1",
        launchId: "12121212-1212-4212-8212-121212121212",
        state: "alive" as const,
        pathObservation: "confirmed" as const,
        observedAt: timestamp(3),
      },
      {
        schemaVersion: 1 as const,
        editorId: "20202020-2020-4020-8020-202020202020",
        pid: 23456,
        processIdentity: "23456:fixture-b",
        projectPath: "C:\\HoneyBee\\workspaces\\save-load",
        workspaceId: "workspace-c",
        ownership: "honeybee" as const,
        ownerRunId: runC,
        ownerWorkId: "save-load",
        slotId: "editor-2",
        launchId: "23232323-2323-4232-8232-232323232323",
        state: "alive" as const,
        pathObservation: "confirmed" as const,
        observedAt: timestamp(3),
      },
    ],
  },
  pool: {
    schemaVersion: 1 as const,
    poolId: "unity-editor",
    capacity: 2,
    active: [
      {
        requestId: "30303030-3030-4030-8030-303030303030",
        ownerRunId: runA,
        ownerWorkId: "inventory-stack",
        priority: "interactive" as const,
        ticket: 1,
        leaseId: "31313131-3131-4131-8131-313131313131",
        slotId: "editor-1",
      },
      {
        requestId: "40404040-4040-4040-8040-404040404040",
        ownerRunId: runC,
        ownerWorkId: "save-load",
        priority: "background" as const,
        ticket: 2,
        leaseId: "41414141-4141-4141-8141-414141414141",
        slotId: "editor-2",
      },
    ],
    queued: [
      {
        requestId: "50505050-5050-4050-8050-505050505050",
        ownerRunId: runB,
        ownerWorkId: "movement-jitter",
        priority: "validation" as const,
        ticket: 3,
      },
    ],
  },
});

const unsupported = async () => {
  throw new Error("This action is unavailable in the visual QA fixture.");
};

const api: HoneyBeeDesktopApi = {
  bootstrap: async () => ({
    schemaVersion: 2,
    runtime: {
      schemaVersion: 1,
      apiVersion: 1,
      runtimeVersion: "0.6.0",
      stateRoot: "C:\\HoneyBee\\runs",
    },
    profiles: [
      {
        schemaVersion: 1,
        profileId: projectId,
        label: "MyUnityGame",
        projectPath: "C:\\Unity\\MyUnityGame",
        batchConfigPath: "C:\\Unity\\MyUnityGame\\honeybee-v06.json",
        configLabel: "OpenCode · Unity 6000.0.50f1",
        lastOpenedAt: timestamp(4),
      },
    ],
    agents: [
      {
        schemaVersion: 1,
        agentId,
        displayName: "OpenCode",
        provider: "opencode",
        command: { command: "opencode", args: ["run", "--pure"] },
        adapter: "stdio-framed-v2",
        enabled: true,
        createdAt: timestamp(4),
        updatedAt: timestamp(4),
      },
    ],
    agentStatuses: [
      {
        schemaVersion: 1,
        agentId,
        status: "ready",
        checkedAt: timestamp(0),
        version: "OpenCode 1.0.0",
        summary: "The Agent CLI and provider authentication are ready.",
      },
    ],
    preferredAgentIds: { [projectId]: agentId },
    lastUsedAgentId: agentId,
  }),
  chooseProfile: async () => null,
  chooseSetupPath: async () => null,
  discoverProject: unsupported,
  addProject: unsupported,
  setupStatus: unsupported,
  resumeSetup: unsupported,
  cancelSetup: unsupported,
  components: unsupported,
  installComponent: unsupported,
  importSetup: async () => null,
  exportSetup: unsupported,
  removeProfile: unsupported,
  doctor: async () => ({
    schemaVersion: 1,
    checkedAt: timestamp(0),
    projectPath: "C:\\Unity\\MyUnityGame",
    ok: true,
    checks: [],
  }),
  startWorks: unsupported,
  runtimeSnapshot: async () => snapshot,
  runDetail: unsupported,
  readArtifact: unsupported,
  resumeRun: unsupported,
  cancelRun: unsupported,
  getPatch: unsupported,
  controlPatch: unsupported,
  upsertAgent: unsupported,
  removeAgent: unsupported,
  probeAgent: unsupported,
  connectAgent: unsupported,
  listAgentApprovals: async () => ({ schemaVersion: 1, approvals: [] }),
  respondAgentApproval: unsupported,
  setProjectAgentPreference: unsupported,
};

Object.defineProperty(window, "honeybee", { configurable: false, value: api });

const root = document.getElementById("root");
if (root === null) throw new Error("Visual QA root element is missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
