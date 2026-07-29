import { ToolProfileIdSchema } from "@honeybee/domain";

import {
  ToolProfileSchema,
  type CapabilityId,
  type ToolManifest,
  type ToolProfile,
} from "./schemas.js";

export const GENERAL_TOOL_PROFILE_ID = ToolProfileIdSchema.parse("general");

const BASE_GENERAL_DENY = [
  "library.delete",
  "unity.eval.unrestricted",
  "worktree.delete.force",
] as const satisfies readonly CapabilityId[];

const unique = (values: readonly CapabilityId[]): readonly CapabilityId[] => [...new Set(values)];

/**
 * Creates the safe default general profile from available manifests.
 *
 * Low- and medium-risk capabilities are allowed. Capabilities declared by a
 * high-risk tool, plus destructive baseline capabilities, are denied. The
 * resulting canonical profile is agent-independent; adapters may later
 * project it into their own configuration formats.
 */
export const createGeneralToolProfile = (tools: readonly ToolManifest[] = []): ToolProfile => {
  const highRiskCapabilities = tools
    .filter(({ risk }) => risk === "high")
    .flatMap(({ capabilities }) => capabilities);
  const deny = unique([...BASE_GENERAL_DENY, ...highRiskCapabilities]);
  const denied = new Set(deny);
  const allow = unique(
    tools
      .filter(({ risk }) => risk !== "high")
      .flatMap(({ capabilities }) => capabilities)
      .filter((capability) => !denied.has(capability)),
  );

  return ToolProfileSchema.parse({
    id: GENERAL_TOOL_PROFILE_ID,
    displayName: "General",
    tools,
    permissions: { allow, deny },
  });
};
