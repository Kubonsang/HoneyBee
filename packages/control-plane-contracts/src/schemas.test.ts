import { describe, expect, it } from "vitest";

import { RuntimeInfoV1Schema, StartUnityWorksRequestV1Schema } from "./schemas.js";

describe("control-plane contracts", () => {
  it("rejects unknown fields at the public boundary", () => {
    expect(() =>
      RuntimeInfoV1Schema.parse({
        schemaVersion: 1,
        apiVersion: 1,
        runtimeVersion: "0.6.0",
        stateRoot: "C:/state",
        typo: true,
      }),
    ).toThrow();
  });

  it("rejects duplicate Work IDs and impossible parallelism", () => {
    const work = {
      id: "work-a",
      task: "A",
      priority: "interactive" as const,
      capabilities: [{ id: "compile", kind: "compile" as const }],
    };
    const base = {
      schemaVersion: 1 as const,
      batchConfigPath: "C:/config.json",
      projectPath: "C:/project",
      maxParallelWorks: 2,
      works: [work],
    };
    expect(StartUnityWorksRequestV1Schema.safeParse(base).success).toBe(false);
    expect(
      StartUnityWorksRequestV1Schema.safeParse({
        ...base,
        maxParallelWorks: 1,
        works: [work, work],
      }).success,
    ).toBe(false);
  });
});
