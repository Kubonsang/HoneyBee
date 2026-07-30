export type RuntimeErrorCode =
  | "validation.invalid-request"
  | "protocol.invalid-json"
  | "protocol.invalid-message"
  | "protocol.unsupported-version"
  | "protocol.duplicate-request"
  | "protocol.line-limit"
  | "runtime.duplicate-session"
  | "runtime.session-not-found"
  | "runtime.shutting-down"
  | "runtime.stale-run"
  | "runtime.spawn-failed"
  | "runtime.internal"
  | "pty.write-failed"
  | "pty.resize-failed"
  | "pty.stop-failed"
  | "pty.shell-unsupported";

export class RuntimeOperationError extends Error {
  public override readonly name = "RuntimeOperationError";
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly retryable: boolean,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.details = details;
  }
}
