import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  WorkflowConfigV2Schema,
  type AgentCommand,
  type WorkflowConfigV2,
  type WorkflowStep,
} from "@honeybee/orchestration-contracts";

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

const optionalPositiveInteger = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
};

const commonLimits = (parsed: Record<string, unknown>) => {
  const timeoutMs = optionalPositiveInteger(parsed.timeoutMs, "timeoutMs");
  const maxOutputBytes = optionalPositiveInteger(parsed.maxOutputBytes, "maxOutputBytes");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  };
};

const loadV1 = (parsed: Record<string, unknown>, directory: string): WorkflowConfigV2 =>
  WorkflowConfigV2Schema.parse({
    schemaVersion: 2,
    steps: [
      { id: "producer", agent: readAgentCommand(parsed.producer, "producer", directory) },
      { id: "reviewer", agent: readAgentCommand(parsed.reviewer, "reviewer", directory) },
    ],
    ...commonLimits(parsed),
  });

const loadV2 = (parsed: Record<string, unknown>, directory: string): WorkflowConfigV2 => {
  if (!Array.isArray(parsed.steps)) throw new Error("steps must be an array.");
  const steps: WorkflowStep[] = parsed.steps.map((value, index) => {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw new Error(`steps[${index}] must have an id.`);
    }
    return {
      id: value.id as WorkflowStep["id"],
      agent: readAgentCommand(value.agent, `steps[${index}].agent`, directory),
    };
  });
  const result = WorkflowConfigV2Schema.safeParse({
    schemaVersion: 2,
    steps,
    ...commonLimits(parsed),
  });
  if (!result.success) throw new Error(`Invalid schemaVersion 2 config: ${result.error.message}`);
  return result.data;
};

export const loadWorkflowConfig = async (configPath: string): Promise<WorkflowConfigV2> => {
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("The config must be an object.");
  const directory = path.dirname(absolutePath);
  if (parsed.schemaVersion === 1) return loadV1(parsed, directory);
  if (parsed.schemaVersion === 2) return loadV2(parsed, directory);
  throw new Error("The config must use schemaVersion 1 or 2.");
};
