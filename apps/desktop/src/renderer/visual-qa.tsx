import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RunDetailV1Schema, VerifiedPatchViewV1Schema } from "@honeybee/control-plane-contracts";

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
const patchArtifact = {
  artifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  kind: "unity-verified-patch" as const,
  mediaType: "application/vnd.honeybee.unity-patch+json" as const,
  byteLength: 2_148,
  contentDigest: `sha256:${"a".repeat(64)}`,
};

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
    workId: "fix-player-movement-jitter",
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

const completedDetail = RunDetailV1Schema.parse({
  schemaVersion: 1,
  summary: summaries[3],
  events: [
    {
      sequence: 1,
      timestamp: timestamp(3_100),
      type: "workflow.started",
      summary: "Work started with an isolated Unity workspace.",
      artifacts: [],
    },
    {
      sequence: 2,
      timestamp: timestamp(2_600),
      type: "step.completed",
      stepId: "agent",
      summary: "Agent prepared a three-file movement fix.",
      artifacts: [],
    },
    {
      sequence: 3,
      timestamp: timestamp(2_100),
      type: "step.completed",
      stepId: "compile",
      summary: "Compile passed with zero errors.",
      artifacts: [],
    },
    {
      sequence: 4,
      timestamp: timestamp(1_500),
      type: "step.completed",
      stepId: "warm-test",
      summary: "10 warm tests passed.",
      artifacts: [],
    },
    {
      sequence: 5,
      timestamp: timestamp(47),
      type: "workflow.completed",
      summary: "Verified patch is ready for disposition.",
      artifacts: [patchArtifact],
    },
  ],
  artifacts: [patchArtifact],
});

const activeDetail = (runId: string) => {
  const summary = summaries.find((item) => item.runId === runId && !item.terminal) ?? summaries[0];
  return RunDetailV1Schema.parse({
    schemaVersion: 1,
    summary,
    events: [
      {
        sequence: 1,
        timestamp: timestamp(80),
        type: "workflow.started",
        summary: "HoneyBee prepared the isolated Unity workspace.",
        artifacts: [],
      },
      {
        sequence: 2,
        timestamp: timestamp(18),
        type: "step.started",
        stepId: "agent",
        summary: "Agent is inspecting project files and planning the change.",
        artifacts: [],
      },
    ],
    artifacts: [],
  });
};
const textContent = (
  text: string,
  digest: string,
): {
  contentDigest: string;
  byteLength: number;
  format: "text";
  text: string;
  truncated: false;
} => ({
  contentDigest: `sha256:${digest.repeat(64)}`,
  byteLength: text.length,
  format: "text",
  text,
  truncated: false,
});

const verifiedPatch = VerifiedPatchViewV1Schema.parse({
  schemaVersion: 1,
  runId: runDone,
  patch: patchArtifact,
  manifestVersion: 3,
  verification: {
    workspaceIntegrity: "verified",
    compile: "passed",
    warmTest: "passed",
  },
  sourceProjectPath: "C:\\Unity\\MyUnityGame",
  sourceState: "clean",
  disposition: "pending",
  conflictPaths: [],
  files: [
    {
      path: "Assets/Scripts/Player/PlayerMotor.cs",
      operation: "modify",
      before: textContent(
        [
          "using UnityEngine;",
          "",
          "public sealed class PlayerMotor : MonoBehaviour",
          "{",
          "    private Vector3 velocity;",
          "",
          "    void Update()",
          "    {",
          '        var input = new Vector3(Input.GetAxisRaw("Horizontal"), 0f, Input.GetAxisRaw("Vertical"));',
          "        velocity = input.normalized * 6f;",
          "        transform.position += velocity * Time.deltaTime;",
          "    }",
          "}",
        ].join("\n"),
        "b",
      ),
      after: textContent(
        [
          "using UnityEngine;",
          "",
          "public sealed class PlayerMotor : MonoBehaviour",
          "{",
          "    private Vector3 velocity;",
          "    private Vector3 smoothedVelocity;",
          "",
          "    void Update()",
          "    {",
          '        var input = new Vector3(Input.GetAxisRaw("Horizontal"), 0f, Input.GetAxisRaw("Vertical"));',
          "        var targetVelocity = input.normalized * 6f;",
          "        smoothedVelocity = Vector3.Lerp(smoothedVelocity, targetVelocity, 12f * Time.deltaTime);",
          "        transform.position += smoothedVelocity * Time.deltaTime;",
          "    }",
          "}",
        ].join("\n"),
        "c",
      ),
    },
    {
      path: "Assets/Scripts/Player/PlayerInput.cs",
      operation: "modify",
      before: textContent('public float Horizontal => Input.GetAxisRaw("Horizontal");', "d"),
      after: textContent('public float Horizontal => Input.GetAxis("Horizontal");', "e"),
    },
    {
      path: "Assets/Scripts/Utils/JitterDamping.cs",
      operation: "add",
      after: textContent(
        "public static class JitterDamping { public const float Strength = 12f; }",
        "f",
      ),
    },
  ],
  allowedActions: ["apply", "reject"],
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
  projectCatalog: async () => ({
    schemaVersion: 1,
    observedAt: timestamp(0),
    projects: [
      {
        schemaVersion: 1,
        projectPath: "C:\\Unity\\MyUnityGame",
        label: "MyUnityGame",
        source: "managed",
        profileId: projectId,
        lastOpenedAt: timestamp(4),
      },
    ],
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
  cloneRunDraft: unsupported,
  runtimeSnapshot: async () => snapshot,
  runDetail: async (request) =>
    request.runId === runDone ? completedDetail : activeDetail(request.runId),
  terminalSnapshot: async (request) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const cursor = Math.min(2, request.afterCursor + 1);
    return {
      schemaVersion: 1,
      instanceId: "00000000-0000-4000-8000-000000000099",
      cursor,
      state: cursor < 2 ? ("running" as const) : ("completed" as const),
      entries:
        request.afterCursor === 0
          ? [
              {
                cursor: 1,
                runId: request.runId,
                stepId: "unity-agent",
                timestamp: timestamp(1),
                channel: "system" as const,
                mode: request.mode,
                text: "Inspecting the selected Run.",
              },
            ]
          : request.afterCursor === 1
            ? [
                {
                  cursor: 2,
                  runId: request.runId,
                  stepId: "unity-agent",
                  timestamp: timestamp(2),
                  channel: "assistant" as const,
                  mode: request.mode,
                  text: "Terminal stream ready.",
                },
              ]
            : [],
      truncated: false,
      rawAvailable: false,
    };
  },
  openTerminalWindow: async () => true,
  projectTree: async (request) => ({
    schemaVersion: 1,
    relativePath: request.relativePath,
    entries:
      request.relativePath === ""
        ? [
            { name: "Assets", relativePath: "Assets", kind: "directory" as const },
            { name: "Packages", relativePath: "Packages", kind: "directory" as const },
            {
              name: "README.md",
              relativePath: "README.md",
              kind: "file" as const,
              byteLength: 42,
            },
          ]
        : request.relativePath === "Assets"
          ? [{ name: "Scripts", relativePath: "Assets/Scripts", kind: "directory" as const }]
          : [
              {
                name: "PlayerController.cs",
                relativePath: "Assets/Scripts/PlayerController.cs",
                kind: "file" as const,
                byteLength: 256,
              },
            ],
    truncated: false,
  }),
  readProjectFile: async (request) => ({
    schemaVersion: 1,
    relativePath: request.relativePath,
    encoding: "utf8",
    content: "public sealed class PlayerController\n{\n    // HoneyBee workbench preview\n}\n",
    byteLength: 82,
    truncated: false,
    language: "csharp",
  }),
  searchProject: async (request) => ({
    schemaVersion: 1,
    query: request.query,
    matches: [
      {
        name: "PlayerController.cs",
        relativePath: "Assets/Scripts/PlayerController.cs",
        kind: "file",
        byteLength: 256,
      },
    ],
    truncated: false,
  }),
  createPty: async (request) => ({
    schemaVersion: 1,
    sessionId: "00000000-0000-4000-8000-000000000088",
    profileId: request.profileId,
    kind: request.kind,
    label: request.kind === "agent" ? "OpenCode" : "PowerShell",
    state: "running",
    createdAt: timestamp(0),
  }),
  ptySnapshot: async (request) => ({
    schemaVersion: 1,
    session: {
      schemaVersion: 1,
      sessionId: request.sessionId,
      profileId: projectId,
      kind: "shell",
      label: "PowerShell",
      state: "running",
      createdAt: timestamp(0),
    },
    cursor: 1,
    chunks: request.afterCursor === 0 ? [{ cursor: 1, data: "PS C:\\Unity\\MyUnityGame> " }] : [],
    truncated: false,
  }),
  writePty: async () => true,
  resizePty: async () => true,
  closePty: async () => true,
  gitSnapshot: async () => ({
    schemaVersion: 1,
    available: true,
    projectPath: "C:\\Unity\\MyUnityGame",
    repositoryRoot: "C:\\Unity\\MyUnityGame",
    currentBranch: "main",
    worktrees: [
      {
        path: "C:\\Unity\\MyUnityGame",
        branch: "main",
        head: "0123456789abcdef0123456789abcdef01234567",
        kind: "source",
        status: "clean",
      },
    ],
  }),
  materializeRunWorktree: unsupported,
  mergeRunWorktree: unsupported,
  finalizeIntegration: unsupported,
  readArtifact: unsupported,
  resumeRun: unsupported,
  cancelRun: unsupported,
  getPatch: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    return verifiedPatch;
  },
  controlPatch: unsupported,
  upsertAgent: unsupported,
  removeAgent: unsupported,
  probeAgent: unsupported,
  connectAgent: unsupported,
  listAgentApprovals: async () => ({ schemaVersion: 1, approvals: [] }),
  respondAgentApproval: unsupported,
  setProjectAgentPreference: unsupported,
  developerSettings: async () => ({
    schemaVersion: 1,
    dogfoodMetricsEnabled: false,
    rawAgentProtocolEnabled: false,
  }),
  updateDeveloperSettings: unsupported,
  preferences: async () => ({
    schemaVersion: 1,
    density: "comfortable",
    terminalFontSize: 12,
    fileExplorerWidth: 280,
    workbenchDefault: "files",
    reducedMotion: false,
  }),
  updatePreferences: unsupported,
  dogfoodStatus: async () => ({
    schemaVersion: 1,
    enabled: false,
    state: "idle",
    observedAt: timestamp(0),
  }),
  startDogfood: unsupported,
  finalizeDogfood: unsupported,
  openDogfoodEvidence: unsupported,
};

Object.defineProperty(window, "honeybee", { configurable: false, value: api });

const root = document.getElementById("root");
if (root === null) throw new Error("Visual QA root element is missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
