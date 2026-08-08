import type { AgentRole } from "./types.js";

export type HoneyBeeCoreErrorCode =
  | "validation.invalid-task"
  | "validation.invalid-command"
  | "agent.spawn-failed"
  | "agent.timed-out"
  | "agent.output-limit"
  | "agent.non-zero-exit"
  | "agent.empty-output";

export class HoneyBeeCoreError extends Error {
  public override readonly name = "HoneyBeeCoreError";

  public constructor(
    public readonly code: HoneyBeeCoreErrorCode,
    message: string,
    public readonly role?: AgentRole,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
