#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  ChildProcessAgentRunner,
  HandoffWorkflow,
  HoneyBeeCoreError,
  type HandoffEvent,
  type HandoffRunRequest,
} from "@honeybee/core";

import { loadHandoffConfig } from "./config.js";

const VERSION = "0.1.0";
const HELP = `HoneyBee CLI ${VERSION}

Usage:
  honeybee demo --task <text> [--json]
  honeybee run --config <file> --task <text> [--json]

Commands:
  demo  Prove the handoff with two deterministic, real child processes.
  run   Run a producer -> reviewer handoff using configured CLI agents.
`;

interface ParsedArguments {
  readonly command: "demo" | "run" | "help" | "version";
  readonly task?: string;
  readonly config?: string;
  readonly json: boolean;
}

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
};

const parseArguments = (args: readonly string[]): ParsedArguments => {
  if (args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    return { command: "help", json: false };
  }
  if (args[0] === "version" || args.includes("--version")) {
    return { command: "version", json: false };
  }
  if (args[0] !== "demo" && args[0] !== "run") {
    throw new Error(`Unknown command: ${args[0] ?? ""}`);
  }
  const task = optionValue(args, "--task");
  const config = optionValue(args, "--config");
  return {
    command: args[0],
    ...(task === undefined ? {} : { task }),
    ...(config === undefined ? {} : { config }),
    json: args.includes("--json"),
  };
};

const eventLine = (event: HandoffEvent): string => {
  switch (event.type) {
    case "agent.started":
      return `[${event.role}] started pid=${event.pid} command=${event.command}`;
    case "agent.completed":
      return `[${event.role}] completed pid=${event.pid} duration=${event.durationMs}ms output=${event.outputBytes}B`;
    case "handoff.created":
      return `[handoff] ${event.from} -> ${event.to} content=${event.contentBytes}B`;
    case "workflow.completed":
      return `[workflow] completed result=${event.resultBytes}B`;
  }
};

const demoRequest = (task: string): HandoffRunRequest => {
  const demoAgentPath = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  return {
    task,
    producer: { command: process.execPath, args: [demoAgentPath, "producer"] },
    reviewer: { command: process.execPath, args: [demoAgentPath, "reviewer"] },
    timeoutMs: 10_000,
  };
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.task === undefined || args.task.trim().length === 0) {
    throw new Error("--task is required.");
  }

  let request: HandoffRunRequest;
  if (args.command === "demo") {
    request = demoRequest(args.task);
  } else {
    if (args.config === undefined) throw new Error("--config is required for run.");
    request = await loadHandoffConfig(args.config, args.task);
  }

  const eventOutput = args.json ? process.stderr : process.stdout;
  const workflow = new HandoffWorkflow(new ChildProcessAgentRunner(), (event) => {
    eventOutput.write(`${eventLine(event)}\n`);
  });
  const result = await workflow.run(request);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        task: result.task,
        producer: {
          pid: result.producer.pid,
          command: result.producer.command,
          exitCode: result.producer.exitCode,
          durationMs: result.producer.durationMs,
        },
        handoff: result.handoff,
        reviewer: {
          pid: result.reviewer.pid,
          command: result.reviewer.command,
          exitCode: result.reviewer.exitCode,
          durationMs: result.reviewer.durationMs,
        },
        result: result.result,
      })}\n`,
    );
    return;
  }
  process.stdout.write(`\nFinal result\n${result.result}\n`);
};

void main().catch((error: unknown) => {
  const payload =
    error instanceof HoneyBeeCoreError
      ? { ok: false, code: error.code, role: error.role, message: error.message }
      : {
          ok: false,
          code: "cli.invalid-request",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
