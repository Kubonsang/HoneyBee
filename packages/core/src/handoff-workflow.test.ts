import { describe, expect, it } from "vitest";

import { HandoffWorkflow } from "./handoff-workflow.js";
import type {
  AgentProcessRequest,
  AgentProcessResult,
  AgentProcessRunner,
  HandoffEvent,
} from "./types.js";

class RecordingRunner implements AgentProcessRunner {
  public readonly requests: AgentProcessRequest[] = [];

  public async run(
    request: AgentProcessRequest,
    onStarted?: (pid: number) => void,
  ): Promise<AgentProcessResult> {
    this.requests.push(request);
    const pid = request.role === "producer" ? 101 : 202;
    onStarted?.(pid);
    return {
      role: request.role,
      pid,
      command: request.command.command,
      exitCode: 0,
      stdout: request.role === "producer" ? "producer artifact" : "final answer",
      stderr: "",
      durationMs: 3,
    };
  }
}

describe("HandoffWorkflow", () => {
  it("passes the first agent output to the second and returns the second result", async () => {
    const runner = new RecordingRunner();
    const events: HandoffEvent[] = [];
    const workflow = new HandoffWorkflow(runner, (event) => events.push(event));

    const result = await workflow.run({
      task: "design a bee counter",
      producer: { command: "agent-a" },
      reviewer: { command: "agent-b" },
    });

    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0]?.prompt).toContain("design a bee counter");
    expect(runner.requests[1]?.prompt).toContain("producer artifact");
    expect(result.handoff).toBe("producer artifact");
    expect(result.result).toBe("final answer");
    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "agent.completed",
      "handoff.created",
      "agent.started",
      "agent.completed",
      "workflow.completed",
    ]);
  });

  it("rejects an empty task before starting a process", async () => {
    const runner = new RecordingRunner();
    const workflow = new HandoffWorkflow(runner);

    await expect(
      workflow.run({ task: "  ", producer: { command: "a" }, reviewer: { command: "b" } }),
    ).rejects.toMatchObject({ code: "validation.invalid-task" });
    expect(runner.requests).toHaveLength(0);
  });
});
