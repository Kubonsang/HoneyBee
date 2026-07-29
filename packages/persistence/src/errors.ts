export const repositoryErrorCodes = ["not-found", "validation", "conflict", "unknown"] as const;

export type RepositoryErrorCode = (typeof repositoryErrorCodes)[number];

export class RepositoryError extends Error {
  public override readonly name = "RepositoryError";
  public readonly details: Readonly<Record<string, unknown>> | undefined;
  public override readonly cause: unknown;

  public constructor(
    public readonly code: RepositoryErrorCode,
    message: string,
    options: Readonly<{
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    }> = {},
  ) {
    super(message);
    this.details = options.details;
    this.cause = options.cause;
  }
}
