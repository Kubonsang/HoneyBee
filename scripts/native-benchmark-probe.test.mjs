import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { benchmarkConfig } from "../dogfood/native-benchmark-probe.mjs";

describe("native benchmark probe", () => {
  it("keeps runtime-only Agent trust outside the strict raw batch config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honeybee-native-probe-"));
    const source = path.join(root, "base.json");
    const target = path.join(root, "benchmark.json");
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 3,
        mode: "unity-batch",
        transaction: {
          agent: {
            command: { command: "placeholder" },
            harness: "stdio-framed-v2",
          },
        },
      }),
      "utf8",
    );

    const result = await benchmarkConfig(source, target);
    const serialized = JSON.parse(await readFile(target, "utf8"));

    expect(serialized.transaction.agent).toEqual(result.config.transaction.agent);
    expect(serialized.transaction.agent).not.toHaveProperty("trust");
    expect(serialized.transaction.agent).not.toHaveProperty("adapter");
    expect(result.runtimeAgent).toHaveProperty("trust");
    expect(result.runtimeAgent.adapter).toBe("stdio-framed-v2");
  });
});
