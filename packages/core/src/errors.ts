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
  | "workspace.invalid-project"
  | "workspace.already-exists"
  | "workspace.cleanup-unsafe"
  | "workspace.residual-detected"
  | "workspace.command-failed"
  | "workspace.command-ambiguous"
  | "workspace.protocol-invalid"
  | "workspace.release-failed"
  | "testplay.failed"
  | "source.modified"
  | "source.check-failed"
  | "transaction.interrupted"
  | "process.identity-failed"
  | "process.drain-failed"
  | "run.already-exists"
  | "run.not-found"
  | "run.invalid-path"
  | "run.indeterminate"
  | "run.not-resumable"
  | "run.lease-failed"
  | "run.already-running"
  | "run.terminal"
  | "run.cleanup-pending";

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
