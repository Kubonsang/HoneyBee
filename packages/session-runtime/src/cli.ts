#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";

import { RuntimeInstanceIdSchema } from "@honeybee/domain";

import { NodePtyFactory } from "./node-pty-adapter.js";
import { RuntimeJsonlServer } from "./server.js";
import { PtySessionManager } from "./session-manager.js";

const diagnostic = (message: string, error?: unknown): void => {
  const suffix =
    error === undefined ? "" : ` ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[honeybee-runtime] ${message}${suffix}\n`);
};

const manager = new PtySessionManager(new NodePtyFactory(), {
  logDirectory: process.env.HONEYBEE_LOG_DIR ?? path.resolve(".honeybee", "logs"),
  diagnostic,
});
const server = new RuntimeJsonlServer(manager, {
  diagnostic,
  runtimeInstanceId: RuntimeInstanceIdSchema.parse(`runtime-${randomUUID()}`),
  onShutdown: () => {
    process.stdin.pause();
    process.stdout.write("", () => process.exit(0));
  },
});

server.start(process.stdin, process.stdout);

const shutdown = async (): Promise<void> => {
  await server.stop();
  process.exitCode = 0;
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("uncaughtException", (error) => {
  diagnostic("Uncaught Runtime exception.", error);
  void shutdown().finally(() => {
    process.exitCode = 1;
  });
});
process.once("unhandledRejection", (error) => {
  diagnostic("Unhandled Runtime rejection.", error);
  void shutdown().finally(() => {
    process.exitCode = 1;
  });
});
