import { expect, it } from "vitest";
import { WorkspaceCoreError } from "@honeybee/core";
import { desktopError } from "../main/desktop-errors.js";
import { decodeDesktopError } from "./desktop-api.js";
import { canRetryManually, errorGuidance, operationError } from "./operation-errors.js";

it("carries unknown commit diagnostics through IPC and offers no immediate retry", () => {
  const original = new WorkspaceCoreError(
    "storage.commit-outcome-unknown",
    "requestId=commit-1; transactionId=transaction-1; timeoutMs=600000; elapsedMs=600000",
    {
      upstreamCode: "workspace-command-failed",
      remediation: ["Preserve the transaction IDs before recovery."],
    },
  );
  const envelope = desktopError(original);
  const decoded = decodeDesktopError(new Error(JSON.stringify({ honeybeeError: envelope })));
  expect(operationError(decoded)).toEqual(envelope);
  expect(errorGuidance(envelope.code, envelope.upstreamCode)).toBe("cacheCommitUnknownHelp");
  expect(canRetryManually(envelope.code)).toBe(false);
});
