import { randomUUID } from "node:crypto";
import path from "node:path";

import { EventIdSchema, RunIdSchema, StepIdSchema } from "@honeybee/orchestration-contracts";
import { describe, expect, it } from "vitest";

import { DesktopAgentApprovalBroker } from "./agent-approval-broker.js";

const request = (kind: "command" | "file-change" | "permissions", serializedRequest: string) => ({
  approvalId: EventIdSchema.parse(randomUUID()),
  runId: RunIdSchema.parse(randomUUID()),
  stepId: StepIdSchema.parse("unity-agent"),
  kind,
  summary: "Approval required.",
  serializedRequest,
  workspacePath: path.resolve("test-workspace"),
});

describe("DesktopAgentApprovalBroker", () => {
  it("allows only workspace mutable file changes and hard-denies protected paths", async () => {
    const broker = new DesktopAgentApprovalBroker();
    await expect(
      broker.decide(
        request("file-change", JSON.stringify({ filePath: "Assets/Scripts/Player.cs" })),
      ),
    ).resolves.toMatchObject({ decision: "allow-once", source: "policy" });
    await expect(
      broker.decide(
        request(
          "file-change",
          JSON.stringify({ filePath: "Packages/com.testplay.bridge/Editor/Bridge.cs" }),
        ),
      ),
    ).resolves.toMatchObject({ decision: "deny", source: "policy" });
    await expect(
      broker.decide(
        request("file-change", JSON.stringify({ filePath: "..\\source\\Assets\\Player.cs" })),
      ),
    ).resolves.toMatchObject({ decision: "deny", source: "policy" });
  });

  it("queues a command until the user chooses once", async () => {
    const broker = new DesktopAgentApprovalBroker();
    const value = request("command", JSON.stringify({ command: "dotnet test" }));
    const pending = broker.decide(value);
    expect(broker.pending()).toHaveLength(1);
    broker.respond(value.approvalId, "allow-once");
    await expect(pending).resolves.toMatchObject({
      decision: "allow-once",
      source: "user",
    });
    expect(broker.pending()).toHaveLength(0);
  });

  it("denies permission escalation without prompting", async () => {
    const broker = new DesktopAgentApprovalBroker();
    await expect(
      broker.decide(request("permissions", JSON.stringify({ reason: "elevation" }))),
    ).resolves.toMatchObject({ decision: "deny", source: "policy" });
    expect(broker.pending()).toHaveLength(0);
  });
});
