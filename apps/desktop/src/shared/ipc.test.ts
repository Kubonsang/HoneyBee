import { describe, expect, it } from "vitest";

import { DesktopStartRequestV1Schema } from "./ipc.js";

describe("Desktop IPC contracts", () => {
  it("rejects unknown renderer fields and invalid capability selections", () => {
    const request = {
      schemaVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      maxParallelWorks: 1,
      works: [
        {
          id: "work-1",
          task: "Change the scene",
          priority: "validation",
          capabilities: [{ id: "compile", kind: "compile" }],
          prompt: "unexpected",
        },
      ],
    };

    expect(DesktopStartRequestV1Schema.safeParse(request).success).toBe(false);
    expect(
      DesktopStartRequestV1Schema.safeParse({
        schemaVersion: 1,
        profileId: request.profileId,
        maxParallelWorks: 1,
        works: [
          {
            id: "work-1",
            task: "Change the scene",
            priority: "validation",
            capabilities: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
