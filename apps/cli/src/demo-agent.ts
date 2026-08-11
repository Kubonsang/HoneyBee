#!/usr/bin/env node

import { AgentInputEnvelopeV2Schema, PortNameSchema } from "@honeybee/orchestration-contracts";

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
  const envelope = AgentInputEnvelopeV2Schema.parse(
    JSON.parse(block(prompt, "HONEYBEE_INPUT_BEGIN", "HONEYBEE_INPUT_END")),
  );
  if (label === "fail" || (label === "flaky" && envelope.step.attempt === 1)) {
    process.stderr.write("deterministic Agent failure\n");
    process.exitCode = 7;
  } else {
    if (label === "slow") await new Promise((resolve) => setTimeout(resolve, 1_000));
    const previous = envelope.inputs[PortNameSchema.parse("previous")]?.content;
    const joined = Object.values(envelope.inputs)
      .map((value) => value.content)
      .join(" | ");
    const content =
      Object.keys(envelope.inputs).length === 0
        ? `DEMO_HANDOFF pid=${process.pid} step=${label} task=${envelope.task.content}`
        : `DEMO_RESULT pid=${process.pid} step=${label} previous=${previous ?? joined} task=${envelope.task.content}`;
    process.stdout.write(
      `HONEYBEE_RESPONSE_BEGIN\n${JSON.stringify({
        schemaVersion: 2,
        runId: envelope.runId,
        stepId: envelope.step.id,
        status: "completed",
        outputs: {
          content: { mediaType: "text/plain; charset=utf-8", content },
        },
      })}\nHONEYBEE_RESPONSE_END`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
