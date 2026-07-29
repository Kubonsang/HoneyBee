import { describe, expect, it } from "vitest";

import { CapabilityPolicySchema, ToolManifestSchema, ToolProfileSchema } from "./index.js";

describe("ToolProfileSchema", () => {
  it("parses a profile with the domain ToolProfile ID", () => {
    const profile = ToolProfileSchema.parse({
      id: "reviewer",
      displayName: "Reviewer",
      tools: [
        {
          schemaVersion: "1",
          id: "unity-ctx",
          adapter: "unity-ctx",
          capabilities: ["scene.read"],
          risk: "low",
        },
      ],
      permissions: {
        allow: ["scene.read"],
        deny: ["git.write"],
      },
    });

    expect(profile.id).toBe("reviewer");
    expect(profile.tools[0]?.capabilities).toEqual(["scene.read"]);
  });

  it("rejects overlapping allow and deny capabilities", () => {
    const result = CapabilityPolicySchema.safeParse({
      allow: ["scene.read"],
      deny: ["scene.read"],
    });

    expect(result.success).toBe(false);
  });
});

describe("ToolManifestSchema", () => {
  it("rejects adapter-specific fields from the minimum contract", () => {
    const result = ToolManifestSchema.safeParse({
      schemaVersion: "1",
      id: "testplay",
      adapter: "testplay-runner",
      capabilities: ["test.run"],
      risk: "medium",
      executablePath: "D:\\tools\\testplay.exe",
    });

    expect(result.success).toBe(false);
  });
});
