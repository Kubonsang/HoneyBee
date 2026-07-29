import { ProjectIdSchema, WorkspaceIdSchema, type WorkspaceId } from "@honeybee/domain";
import { z } from "zod";

/**
 * The stable identity and filesystem location needed to refer to a workspace.
 *
 * Git branch state, Library preparation state, locks, and Unity process state
 * are intentionally absent. Application workflows may coordinate dedicated
 * ports for those concerns without turning this reference into a manager.
 */
export const WorkspaceDescriptorSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: ProjectIdSchema,
    rootPath: z.string().trim().min(1).max(32_767),
  })
  .strict();

export type WorkspaceDescriptor = z.infer<typeof WorkspaceDescriptorSchema>;

/**
 * Read boundary for resolving workspace references.
 *
 * Creation, Git worktree operations, storage preparation, locks, and Unity
 * probes belong to separate application workflows and ports. Implementations
 * of this interface must not gain those responsibilities as convenience
 * methods.
 */
export interface WorkspacePort {
  getById(id: WorkspaceId): Promise<WorkspaceDescriptor | undefined>;
  list(): Promise<readonly WorkspaceDescriptor[]>;
}
