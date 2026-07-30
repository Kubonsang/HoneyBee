export const domainErrorCodes = [
  "invalid-session",
  "invalid-tag",
  "duplicate-tag",
  "tag-not-found",
  "self-reference",
  "duplicate-relationship",
  "reference-not-found",
  "parent-cycle",
  "attempt-transition-conflict",
  "session-run-transition-conflict",
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export class DomainError extends Error {
  public override readonly name = "DomainError";
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.details = details;
  }
}
