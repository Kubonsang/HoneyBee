export class ApplicationError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.details = details;
  }
}
