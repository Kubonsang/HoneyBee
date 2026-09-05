import { WorkspaceCoreError } from "@honeybee/core";
import { ZodError } from "zod";

import type { DesktopErrorV1 } from "../shared/ipc.js";

export class DesktopMainError extends Error {
  public readonly code: string;
  public readonly remediation: readonly string[];

  public constructor(
    code: string,
    message: string,
    remediation: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesktopMainError";
    this.code = code;
    this.remediation = remediation;
  }
}

export const desktopError = (reason: unknown): DesktopErrorV1 => {
  if (reason instanceof WorkspaceCoreError || reason instanceof DesktopMainError) {
    return {
      code: reason.code,
      message: reason.message,
      remediation: [...reason.remediation],
      ...(reason instanceof WorkspaceCoreError && reason.upstreamCode !== undefined
        ? { upstreamCode: reason.upstreamCode }
        : {}),
    };
  }
  if (reason instanceof ZodError) {
    return {
      code: "desktop.request-invalid",
      message: "The Desktop request was invalid.",
      remediation: [],
    };
  }
  return {
    code: "desktop.operation-failed",
    message: reason instanceof Error ? reason.message : "The Desktop operation failed.",
    remediation: ["Try the operation again. If it continues to fail, run honeybee doctor."],
  };
};
