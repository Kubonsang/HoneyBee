#!/usr/bin/env node

import { createHash } from "node:crypto";

const readInput = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
};

const block = (input: string, name: string): string => {
  const match = new RegExp(
    `HONEYBEE_${name}_BEGIN\\n([\\s\\S]*?)\\nHONEYBEE_${name}_END`,
    "u",
  ).exec(input);
  if (match?.[1] === undefined) {
    process.stderr.write(`Missing ${name.toLocaleLowerCase()} block.\n`);
    process.exit(2);
  }
  return match[1];
};

const role = process.argv[2];
const input = await readInput();
if (role === "producer") {
  const task = block(input, "TASK");
  process.stdout.write(`DEMO_HANDOFF pid=${process.pid} task=${task}`);
} else if (role === "reviewer") {
  const task = block(input, "TASK");
  const handoff = block(input, "HANDOFF");
  const digest = createHash("sha256").update(handoff, "utf8").digest("hex").slice(0, 12);
  process.stdout.write(
    `DEMO_RESULT pid=${process.pid} received=${digest} producer=${handoff} task=${task}`,
  );
} else {
  process.stderr.write("Expected producer or reviewer role.\n");
  process.exit(2);
}
