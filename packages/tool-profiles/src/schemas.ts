import { ToolProfileIdSchema } from "@honeybee/domain";
import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(256);

/** A stable, adapter-independent capability name such as `test.run`. */
export const CapabilityIdSchema = identifierSchema;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/**
 * Explicit allow/deny policy. An overlapping capability is rejected so
 * adapters do not have to guess precedence.
 */
export const CapabilityPolicySchema = z
  .object({
    allow: z.array(CapabilityIdSchema),
    deny: z.array(CapabilityIdSchema),
  })
  .strict()
  .superRefine(({ allow, deny }, context) => {
    const allowed = new Set(allow);
    deny.forEach((capability, index) => {
      if (allowed.has(capability)) {
        context.addIssue({
          code: "custom",
          message: `Capability "${capability}" cannot be both allowed and denied.`,
          path: ["deny", index],
        });
      }
    });
  });

export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;

/** Risk metadata used by profile factories and permission surfaces. */
export const ToolRiskSchema = z.enum(["low", "medium", "high"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

/**
 * Minimum declaration required to register a tool adapter.
 *
 * Adapter-specific executable paths, arguments, and wire schemas stay with the
 * adapter. The manifest exposes only identity, schema version, capabilities,
 * and risk needed for discovery and policy decisions.
 */
export const ToolManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: identifierSchema,
    adapter: identifierSchema,
    capabilities: z.array(CapabilityIdSchema),
    risk: ToolRiskSchema,
  })
  .strict();

export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** Canonical, agent-independent tool and capability selection. */
export const ToolProfileSchema = z
  .object({
    id: ToolProfileIdSchema,
    displayName: z.string().trim().min(1).max(256),
    tools: z.array(ToolManifestSchema),
    permissions: CapabilityPolicySchema,
  })
  .strict();

export type ToolProfile = z.infer<typeof ToolProfileSchema>;
