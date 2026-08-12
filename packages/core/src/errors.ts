import type { StepId } from "@honeybee/orchestration-contracts";

export type HoneyBeeCoreErrorCode =
  | "validation.invalid-task"
  | "validation.invalid-workflow"
  | "validation.invalid-command"
  | "agent.spawn-failed"
  | "agent.input-write-failed"
  | "agent.timed-out"
  | "agent.output-limit"
  | "agent.non-zero-exit"
  | "agent.cancelled"
  | "protocol.invalid-agent-response"
  | "artifact.write-failed"
  | "artifact.read-failed"
  | "artifact.publish-failed"
  | "artifact.integrity-failed"
  | "artifact.required-input-missing"
  | "condition.evaluation-failed"
  | "control.write-failed"
  | "control.read-failed"
  | "journal.write-failed"
  | "workflow.step-failed"
  | "run.already-exists"
  | "run.not-found"
  | "run.invalid-path"
  | "run.indeterminate"
  | "run.not-resumable"
  | "run.lease-failed"
  | "run.already-running"
  | "run.terminal";

export class HoneyBeeCoreError extends Error {
  public override readonly name = "HoneyBeeCoreError";

  public constructor(
    public readonly code: HoneyBeeCoreErrorCode,
    message: string,
    public readonly stepId?: StepId,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
