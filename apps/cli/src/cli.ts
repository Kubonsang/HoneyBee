#!/usr/bin/env node

import { acquireInstalledActivity, WorkspaceCoreError } from "@honeybee/core";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatError } from "./human-output.js";
import { CLI_JSON_SCHEMA_VERSION, jsonEnabled, runWorkspaceCli } from "./workspace-command.js";

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  // Doctor is observational and must run while an updater holds exclusive activity.
  // This exception never dispatches a project/cache/workspace command.
  const lease =
    args[0] === "doctor"
      ? undefined
      : await acquireInstalledActivity(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        );
  try {
    lease?.assertHeld();
    await runWorkspaceCli(args);
    lease?.assertHeld();
  } finally {
    await lease?.release();
  }
};
void run().catch((error: unknown) => {
  const payload =
    error instanceof WorkspaceCoreError
      ? {
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          ok: false,
          code: error.code,
          message: error.message,
        }
      : {
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          ok: false,
          code: "cli.invalid-request",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(
    jsonEnabled(process.argv.slice(2)) ? `${JSON.stringify(payload)}\n` : `${formatError(error)}\n`,
  );
  process.exitCode = 1;
});
