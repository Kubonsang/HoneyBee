import { describe, expect, it } from "vitest";

import { GENERAL_TOOL_PROFILE_ID, createGeneralToolProfile, type ToolManifest } from "./index.js";

const manifests: readonly ToolManifest[] = [
  {
    schemaVersion: "1",
    id: "unity-ctx",
    adapter: "unity-ctx",
    capabilities: ["scene.read", "asset.read"],
    risk: "low",
  },
  {
    schemaVersion: "1",
    id: "testplay",
    adapter: "testplay-runner",
    capabilities: ["test.run", "asset.read"],
    risk: "medium",
  },
  {
    schemaVersion: "1",
    id: "unity-eval",
    adapter: "official-unity-cli",
    capabilities: ["unity.eval.unrestricted"],
    risk: "high",
  },
];

describe("createGeneralToolProfile", () => {
  it("allows declared ordinary capabilities and denies high-risk capabilities", () => {
    const profile = createGeneralToolProfile(manifests);

    expect(profile.id).toBe(GENERAL_TOOL_PROFILE_ID);
    expect(profile.permissions.allow).toEqual(["scene.read", "asset.read", "test.run"]);
    expect(profile.permissions.deny).toContain("unity.eval.unrestricted");
    expect(profile.tools).toEqual(manifests);
  });

  it("creates a valid empty general profile", () => {
    expect(createGeneralToolProfile()).toMatchObject({
      id: "general",
      displayName: "General",
      tools: [],
      permissions: { allow: [] },
    });
  });
});
