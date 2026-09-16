import assert from "node:assert/strict";

/** Adopt legacy tool bindings using the core's digest-checked registry mutation.
 * Preflight the complete set first. Never re-register projects, reset workspaces,
 * copy repositories, or restore an old whole registry over concurrent changes. */
export async function adoptInstalledProjects(core, record) {
  assert.equal(typeof record, "function");
  const projects = await core.listProjects();
  assert(projects.length <= 10000, "Project adoption exceeds bound");
  const plans = [];
  for (const project of projects)
    plans.push(await core.planProjectStorageAdoption(project.projectId));
  assert.equal(new Set(plans.map((p) => p.projectId)).size, plans.length);
  await record("adoption-planned", { schemaVersion: 1, plans });
  const blocked = plans.filter((p) => p.status === "blocked");
  if (blocked.length) return { ready: false, adopted: [], blocked };
  assert(
    plans.every((p) => ["ready", "already-adopted"].includes(p.status)),
    "Unknown adoption state",
  );
  const adopted = [];
  for (const [index, plan] of plans.entries()) {
    if (plan.status === "already-adopted") continue;
    try {
      await record(`adoption-${index}-requested`, {
        schemaVersion: 1,
        projectId: plan.projectId,
        projectDigest: plan.projectDigest,
      });
      await core.adoptProjectStorage(plan.projectId, plan.projectDigest);
      adopted.push(plan.projectId);
    } catch (error) {
      await record("adoption-incomplete", { schemaVersion: 1, adopted, reason: error.message });
      return {
        ready: false,
        adopted,
        blocked: [{ projectId: plan.projectId, reason: error.message }],
      };
    }
  }
  const result = { ready: true, adopted, blocked: [] };
  await record("adoption-completed", { schemaVersion: 1, ...result });
  return result;
}
