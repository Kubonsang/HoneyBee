import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentCommand, HandoffRunRequest } from "@honeybee/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expandEnvironment = (value: string, name: string): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, variable: string) => {
    const resolved = process.env[variable];
    if (resolved === undefined) {
      throw new Error(`${name} references missing environment variable ${variable}.`);
    }
    return resolved;
  });

const readPositiveInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
};

const readAgentCommand = (value: unknown, name: string, configDirectory: string): AgentCommand => {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`${name}.command must be a non-empty string.`);
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((argument) => typeof argument === "string"))
  ) {
    throw new Error(`${name}.args must be an array of strings.`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`${name}.cwd must be a string.`);
  }
  if (
    value.env !== undefined &&
    (!isRecord(value.env) || !Object.values(value.env).every((entry) => typeof entry === "string"))
  ) {
    throw new Error(`${name}.env must contain only string values.`);
  }

  const cwd =
    typeof value.cwd === "string"
      ? path.resolve(configDirectory, expandEnvironment(value.cwd, `${name}.cwd`))
      : undefined;
  return {
    command: expandEnvironment(value.command, `${name}.command`),
    ...(value.args === undefined ? {} : { args: value.args as string[] }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }),
  };
};

export const loadHandoffConfig = async (
  configPath: string,
  task: string,
): Promise<HandoffRunRequest> => {
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("The config must be an object with schemaVersion 1.");
  }
  const configDirectory = path.dirname(absolutePath);
  return {
    task,
    producer: readAgentCommand(parsed.producer, "producer", configDirectory),
    reviewer: readAgentCommand(parsed.reviewer, "reviewer", configDirectory),
    ...(parsed.timeoutMs === undefined
      ? {}
      : { timeoutMs: readPositiveInteger(parsed.timeoutMs, "timeoutMs") }),
    ...(parsed.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: readPositiveInteger(parsed.maxOutputBytes, "maxOutputBytes") }),
  };
};
