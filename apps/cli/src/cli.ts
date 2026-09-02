#!/usr/bin/env node

import { WorkspaceCoreError } from "@honeybee/core";

import { CLI_JSON_SCHEMA_VERSION, runWorkspaceCli } from "./workspace-command.js";

void runWorkspaceCli(process.argv.slice(2)).catch((error: unknown) => {
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
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
