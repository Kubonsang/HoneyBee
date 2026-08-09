#!/usr/bin/env node

import { AgentInputEnvelopeV1Schema } from "@honeybee/orchestration-contracts";

const readInput = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
};

const block = (input: string, begin: string, end: string): string => {
  const start = input.indexOf(begin);
  const finish = input.indexOf(end);
  if (start < 0 || finish < start) throw new Error(`Missing ${begin} block.`);
  return input.slice(start + begin.length, finish).trim();
};

try {
  const label = process.argv[2] ?? "agent";
  const prompt = await readInput();
  const envelope = AgentInputEnvelopeV1Schema.parse(
    JSON.parse(block(prompt, "HONEYBEE_INPUT_BEGIN", "HONEYBEE_INPUT_END")),
  );
  const content =
    envelope.previous === null
      ? `DEMO_HANDOFF pid=${process.pid} step=${label} task=${envelope.task.content}`
      : `DEMO_RESULT pid=${process.pid} step=${label} previous=${envelope.previous.content} task=${envelope.task.content}`;
  process.stdout.write(
    `HONEYBEE_RESPONSE_BEGIN\n${JSON.stringify({
      schemaVersion: 1,
      runId: envelope.runId,
      stepId: envelope.step.id,
      status: "completed",
      content,
    })}\nHONEYBEE_RESPONSE_END`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
