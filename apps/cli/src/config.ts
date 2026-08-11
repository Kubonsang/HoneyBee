import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentIdSchema,
  HarnessIdSchema,
  PortNameSchema,
  StepIdSchema,
  WorkflowConfigV2Schema,
  WorkflowConfigV3Schema,
  type AgentCommand,
  type AgentDefinition,
  type WorkflowConfigV3,
} from "@honeybee/orchestration-contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejectUnknown = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown field: ${unknown[0]}.`);
};

const expandEnvironment = (value: string, name: string): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, variable: string) => {
    const resolved = process.env[variable];
    if (resolved === undefined) {
      throw new Error(`${name} references missing environment variable ${variable}.`);
    }
    return resolved;
  });

const readAgentCommand = (value: unknown, name: string, configDirectory: string): AgentCommand => {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  rejectUnknown(value, ["command", "args", "cwd", "env"], name);
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
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
    ...(value.args === undefined
      ? {}
      : {
          args: (value.args as string[]).map((entry) => expandEnvironment(entry, `${name}.args`)),
        }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(value.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(value.env as Record<string, string>).map(([key, entry]) => [
              key,
              expandEnvironment(entry, `${name}.env.${key}`),
            ]),
          ),
        }),
  };
};

const canonicalAgent = (id: string, command: AgentCommand): AgentDefinition => ({
  id: AgentIdSchema.parse(id),
  ...command,
});

const linearV3 = (
  commands: readonly Readonly<{ id: string; command: AgentCommand }>[],
  limits: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }>,
): WorkflowConfigV3 => {
  const harnessId = HarnessIdSchema.parse("stdio");
  const finalStep = commands.at(-1);
  if (finalStep === undefined) throw new Error("A sequential workflow needs at least one step.");
  return WorkflowConfigV3Schema.parse({
    schemaVersion: 3,
    agents: commands.map((entry) => canonicalAgent(entry.id, entry.command)),
    harnesses: [{ id: harnessId, kind: "stdio-framed-v1", protocolVersion: 1 }],
    steps: commands.map((entry, index) => ({
      id: StepIdSchema.parse(entry.id),
      type: "agent",
      agentRef: AgentIdSchema.parse(entry.id),
      harnessRef: harnessId,
      ...(index === 0
        ? {}
        : {
            needs: [StepIdSchema.parse(commands[index - 1]?.id)],
            inputs: {
              previous: {
                from: {
                  stepId: StepIdSchema.parse(commands[index - 1]?.id),
                  output: PortNameSchema.parse("content"),
                },
              },
            },
          }),
      outputs: { content: { mediaType: "text/plain; charset=utf-8" } },
    })),
    outputs: {
      result: {
        from: {
          stepId: StepIdSchema.parse(finalStep.id),
          output: PortNameSchema.parse("content"),
        },
      },
    },
    maxParallelism: 1,
    ...(limits.timeoutMs === undefined ? {} : { defaultTimeoutMs: limits.timeoutMs }),
    ...(limits.maxOutputBytes === undefined ? {} : { maxOutputBytes: limits.maxOutputBytes }),
  });
};

const optionalPositiveInteger = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
};

const limits = (value: Record<string, unknown>) => {
  const timeoutMs = optionalPositiveInteger(value.timeoutMs, "timeoutMs");
  const maxOutputBytes = optionalPositiveInteger(value.maxOutputBytes, "maxOutputBytes");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  };
};

const loadV1 = (parsed: Record<string, unknown>, directory: string): WorkflowConfigV3 => {
  rejectUnknown(
    parsed,
    ["schemaVersion", "producer", "reviewer", "timeoutMs", "maxOutputBytes"],
    "config",
  );
  return linearV3(
    [
      { id: "producer", command: readAgentCommand(parsed.producer, "producer", directory) },
      { id: "reviewer", command: readAgentCommand(parsed.reviewer, "reviewer", directory) },
    ],
    limits(parsed),
  );
};

const loadV2 = (parsed: Record<string, unknown>, directory: string): WorkflowConfigV3 => {
  const original = WorkflowConfigV2Schema.safeParse(parsed);
  if (!original.success)
    throw new Error(`Invalid schemaVersion 2 config: ${original.error.message}`);
  return linearV3(
    original.data.steps.map((step, index) => ({
      id: step.id,
      command: readAgentCommand(step.agent, `steps[${index}].agent`, directory),
    })),
    {
      ...(original.data.timeoutMs === undefined ? {} : { timeoutMs: original.data.timeoutMs }),
      ...(original.data.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: original.data.maxOutputBytes }),
    },
  );
};

const loadV3 = (parsed: Record<string, unknown>, directory: string): WorkflowConfigV3 => {
  const original = WorkflowConfigV3Schema.safeParse(parsed);
  if (!original.success)
    throw new Error(`Invalid schemaVersion 3 config: ${original.error.message}`);
  return WorkflowConfigV3Schema.parse({
    ...original.data,
    agents: original.data.agents.map((agent, index) => {
      const { id, ...command } = agent;
      return {
        id,
        ...readAgentCommand(command, `agents[${index}]`, directory),
      };
    }),
  });
};

export const loadWorkflowConfig = async (configPath: string): Promise<WorkflowConfigV3> => {
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("The config must be an object.");
  const directory = path.dirname(absolutePath);
  if (parsed.schemaVersion === 1) return loadV1(parsed, directory);
  if (parsed.schemaVersion === 2) return loadV2(parsed, directory);
  if (parsed.schemaVersion === 3) return loadV3(parsed, directory);
  throw new Error("The config must use schemaVersion 1, 2, or 3.");
};
