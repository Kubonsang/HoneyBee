import { describe, expect, it } from "vitest";

import {
  RunIdSchema,
  StepIdSchema,
  type AgentProcessLifecycle,
  type AgentProcessRequest,
  type AgentSessionLifecycleEventV1,
} from "@honeybee/core";

import {
  CodexAppServerAdapter,
  OpenCodeAcpAdapter,
  type AgentApprovalPort,
} from "./agent-session-adapters.js";

const request = (script: string): AgentProcessRequest => ({
  runId: RunIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  stepId: StepIdSchema.parse("unity-agent"),
  prompt: "Return a framed HoneyBee response.",
  command: { command: process.execPath, args: ["-e", script], cwd: process.cwd() },
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
});

const lifecycle = (events: AgentSessionLifecycleEventV1[]): AgentProcessLifecycle => ({
  onStarted: async () => undefined,
  onRegistered: async () => undefined,
  onExited: async () => undefined,
  onSessionEvent: async (event) => {
    events.push(event);
  },
});

const provider = (body: string): string => String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
${body}
`;

describe("structured Agent session adapters", () => {
  it("times out while provider initialization is pending", async () => {
    const events: AgentSessionLifecycleEventV1[] = [];
    let exited = 0;
    const stalled = provider("rl.on('line', () => undefined);");
    const startedAt = Date.now();
    await expect(
      new CodexAppServerAdapter().run(
        { ...request(stalled), timeoutMs: 50 },
        {
          ...lifecycle(events),
          onExited: async () => {
            exited += 1;
          },
        },
        { decide: async () => Promise.reject(new Error("unexpected approval")) },
      ),
    ).rejects.toMatchObject({ code: "agent.timed-out" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(exited).toBe(1);
  });

  it("rejects pending initialization when the provider exits", async () => {
    const events: AgentSessionLifecycleEventV1[] = [];
    const exitsDuringInitialize = provider(String.raw`
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.exit(0);
});
`);
    await expect(
      new CodexAppServerAdapter().run(request(exitsDuringInitialize), lifecycle(events), {
        decide: async () => Promise.reject(new Error("unexpected approval")),
      }),
    ).rejects.toMatchObject({ code: "protocol.invalid-agent-response" });
  });

  it("runs a Codex app-server turn and normalizes its final message", async () => {
    const events: AgentSessionLifecycleEventV1[] = [];
    const script = provider(String.raw`
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "skills/list") send({ jsonrpc: "2.0", id: message.id, result: { data: [] } });
  else if (message.method === "thread/start") send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "HONEYBEE_RESPONSE_BEGIN\\n" } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "{\\\"schemaVersion\\\":2,\\\"outcome\\\":\\\"completed\\\",\\\"outputs\\\":{\\\"content\\\":{\\\"mediaType\\\":\\\"text/plain; charset=utf-8\\\",\\\"content\\\":\\\"ok\\\"}}}\\nHONEYBEE_RESPONSE_END" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
    const result = await new CodexAppServerAdapter().run(request(script), lifecycle(events), {
      decide: async () => {
        throw new Error("unexpected approval");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("HONEYBEE_RESPONSE_BEGIN");
    expect(events.map((event) => event.type)).toEqual([
      "session-opened",
      "turn-started",
      "skills-observed",
      "turn-completed",
      "session-closed",
    ]);
  });

  it("drains the provider when terminal lifecycle persistence fails", async () => {
    const events: AgentSessionLifecycleEventV1[] = [];
    let containmentPid: number | undefined;
    const script = provider(String.raw`
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "skills/list") send({ jsonrpc: "2.0", id: message.id, result: { data: [] } });
  else if (message.method === "thread/start") send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "done" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
    setInterval(() => undefined, 1000);
  }
});
`);
    await expect(
      new CodexAppServerAdapter().run(
        request(script),
        {
          ...lifecycle(events),
          onStarted: async (pid) => {
            containmentPid = pid;
          },
          onSessionEvent: async (event) => {
            if (event.type === "turn-completed") throw new Error("journal failed");
            events.push(event);
          },
        },
        { decide: async () => Promise.reject(new Error("unexpected approval")) },
      ),
    ).rejects.toThrow("journal failed");
    expect(containmentPid).toBeDefined();
    expect(() => process.kill(containmentPid as number, 0)).toThrow();
  });

  it("persists the normalized approval lifecycle before ACP delivery", async () => {
    const events: AgentSessionLifecycleEventV1[] = [];
    const script = provider(String.raw`
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
  else if (message.method === "session/prompt") {
    global.promptId = message.id;
    send({ jsonrpc: "2.0", id: "approval-1", method: "session/request_permission", params: { options: [{ optionId: "once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
  } else if (message.id === "approval-1" && message.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ jsonrpc: "2.0", id: global.promptId, result: { stopReason: "end_turn" } });
  }
});
`);
    const approval: AgentApprovalPort = {
      decide: async (value) => ({
        schemaVersion: 1,
        approvalId: value.approvalId,
        decision: "allow-once",
        source: "user",
        decidedAt: new Date().toISOString(),
      }),
    };
    const result = await new OpenCodeAcpAdapter().run(request(script), lifecycle(events), approval);
    expect(result.stdout).toBe("done");
    const types = events.map((event) => event.type);
    expect(types.indexOf("approval-requested")).toBeLessThan(types.indexOf("approval-resolved"));
    expect(types.indexOf("approval-resolved")).toBeLessThan(types.indexOf("approval-delivered"));
  });
});
