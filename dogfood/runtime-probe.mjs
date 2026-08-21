import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { HoneyBeeRuntimeFacade } from "../apps/cli/dist/runtime-api.js";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (error) => ({
  code:
    isRecord(error) && typeof error.code === "string" ? error.code : "dogfood.runtime-probe-failed",
  message: error instanceof Error ? error.message : "Runtime probe failed.",
});

try {
  const request = JSON.parse(await readFile(0, "utf8"));
  if (!isRecord(request) || request.schemaVersion !== 1) {
    throw new Error("Runtime probe request must use schemaVersion 1.");
  }
  const stateRoot = path.resolve(String(request.stateRoot));
  const projectPath = path.resolve(String(request.projectPath));
  const configPath = path.resolve(String(request.configPath));
  const runIds = Array.isArray(request.runIds)
    ? request.runIds.filter((value) => typeof value === "string")
    : [];
  const patches = Array.isArray(request.patches)
    ? request.patches.filter(
        (value) =>
          isRecord(value) &&
          typeof value.runId === "string" &&
          typeof value.patchArtifactId === "string",
      )
    : [];
  const runtime = new HoneyBeeRuntimeFacade({ stateRoot });
  const doctor = await runtime
    .doctor({ schemaVersion: 1, projectPath, batchConfigPath: configPath })
    .catch((error) => ({ error: failure(error) }));
  const runs = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return { runId, detail: await runtime.getRunDetail(runId) };
      } catch (error) {
        return { runId, error: failure(error) };
      }
    }),
  );
  const editors = await runtime.listEditors().catch((error) => ({ error: failure(error) }));
  const pool = await runtime
    .inspectEditorPoolForConfig(configPath)
    .catch((error) => ({ error: failure(error) }));
  const patchViews = await Promise.all(
    patches.map(async ({ runId, patchArtifactId }) => {
      try {
        return {
          runId,
          patchArtifactId,
          view: await runtime.getVerifiedPatch(runId, patchArtifactId),
        };
      } catch (error) {
        return { runId, patchArtifactId, error: failure(error) };
      }
    }),
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      runtime: runtime.info(),
      doctor,
      runs,
      editors,
      pool,
      patches: patchViews,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, error: failure(error) }) + "\n");
  process.exitCode = 1;
}
