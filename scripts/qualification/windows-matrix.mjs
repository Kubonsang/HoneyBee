import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { prepareMatrixUpdate, priorControllerNonce } from "./prepared-reuse.mjs";
import { createActivationJob } from "../update/update-job.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { readBounded } from "../update/prepare-release.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";

const optional = async (file) => {
  try {
    return JSON.parse(await readBounded(file, 8 * 1024 * 1024));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
export const waitFile = async (
  directory,
  name,
  timeout = 20 * 60 * 1000,
  check = () => {},
  { read = optional, now = Date.now, pause = delay } = {},
) => {
  const deadline = now() + timeout;
  while (now() < deadline) {
    try {
      const failure = await read(path.join(directory, "native-error.json"));
      assert(!failure, `Native QA controller failed: ${failure?.error}`);
      const value = await read(path.join(directory, name));
      if (value) return value;
    } catch (error) {
      // Windows sharing violations are transient during evidence publication.
      // Do not suppress invalid JSON, permissions, identity or controller errors.
      if (error.code !== "EBUSY") throw error;
    }
    check();
    await pause(100);
  }
  throw Error(`QA evidence timeout: ${name}`);
};
/** Real Windows adapters. Only the service fault controller requires UAC.
 * No SCM mock, direct pointer rewrite, forced VHDX detach or test-only repair. */
export function createWindowsMatrixOperations({
  bundle,
  installationRoot,
  inputs,
  health,
  snapshot,
  bootId,
  env,
}) {
  const run = (file, args, options = {}) =>
    promisify(execFile)(file, args, {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env,
      ...options,
    });
  return {
    bootId,
    snapshot,
    sourceHealth: (kind) =>
      health(
        kind === "service" ? inputs.updates[0].from : inputs.updates[1].from,
        kind === "service" ? inputs.servicePair.source : inputs.servicePair.target,
      ),
    inject: async ({ scenario, caseRoot, priorRoot }) => {
      const kind = scenario.point.startsWith("service-") ? "service" : "app";
      const step = inputs.updates[kind === "service" ? 0 : 1];
      const prepared = await prepareMatrixUpdate({ installationRoot, bundle, step });
      const job = await createActivationJob({ ...prepared, setupActivation: true });
      const config = {
        schemaVersion: 1,
        qualificationOnly: true,
        installationRoot,
        job: { name: job.name, sha256: job.sha256 },
        point: scenario.point,
        action: scenario.action,
        nonce: randomBytes(32).toString("hex"),
        manifestSha256: step.manifestSha256,
        sourceVersion: step.from,
        sourceHostSha256: (kind === "service"
          ? inputs.servicePair.source
          : inputs.servicePair.target
        ).host.sha256,
      };
      if (priorRoot && kind === "service")
        config.previousNonce = await priorControllerNonce(priorRoot);
      const file = path.join(caseRoot, "worker.json");
      await durableQARecord(file, config);
      const digest = sha256(await readFile(file));
      if (kind === "service") {
        await run("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(bundle, "scripts/qualification/launch-native-fault.ps1"),
          "-CaseDirectory",
          caseRoot,
          "-ConfigSha256",
          digest,
        ]);
        try {
          const ready = await waitFile(caseRoot, "native-ready.json", 120000);
          assert.equal(ready.configSha256, digest);
        } catch (error) {
          await durableQARecord(path.join(caseRoot, "controller-cancel.json"), {
            configSha256: digest,
          });
          throw error;
        }
      }
      const child = spawn(
        path.join(installationRoot, "recovery/v1/runtime/node.exe"),
        [path.join(bundle, "scripts/qualification/fault-worker.mjs"), file, digest],
        { env, windowsHide: true, stdio: "ignore" },
      );
      // Capture rejection immediately so an early exit is never unhandled.
      let spawnError,
        exited = false,
        exitAt = 0;
      child.once("error", (e) => {
        spawnError = e;
      });
      const exit = new Promise((resolve) => {
        child.once("exit", (code) => {
          exited = true;
          exitAt = Date.now();
          resolve({ code });
        });
        child.once("error", (error) => {
          exited = true;
          exitAt = Date.now();
          resolve({ error: String(error) });
        });
      });
      let reached;
      try {
        reached = await waitFile(caseRoot, "reached.json", 20 * 60 * 1000, () => {
          assert(
            !exited || (kind === "service" && Date.now() - exitAt < 5000),
            "QA worker exited before the required checkpoint",
          );
        });
      } catch (error) {
        if (kind === "service")
          await durableQARecord(path.join(caseRoot, "controller-cancel.json"), {
            configSha256: digest,
          });
        throw error;
      }
      if (spawnError) throw spawnError;
      assert.equal(reached.configSha256, digest);
      assert.equal(reached.point, scenario.point);
      if (kind === "app" && scenario.action === "kill") {
        assert.equal(reached.processId, child.pid);
        assert.equal(child.exitCode, null, "QA worker already exited");
        assert(child.kill(), "QA worker termination failed");
      }
      if (["kill", "fail"].includes(scenario.action)) {
        const timer = new globalThis.AbortController();
        let result;
        try {
          result = await Promise.race([
            exit,
            delay(180000, undefined, { signal: timer.signal }).then(() => {
              throw Error("Faulted worker did not exit");
            }),
          ]);
        } finally {
          timer.abort();
        }
        await durableQARecord(path.join(caseRoot, "worker-exit.json"), result);
      } else child.unref();
      return {
        reached: true,
        point: scenario.point,
        action: scenario.action,
        evidence: reached,
        reachedAt: (reached.native ?? reached).reachedAt,
        holdDeadline: (reached.native ?? reached).holdDeadline,
      };
    },
    recover: async ({ scenario, caseRoot }) => {
      if (scenario.action === "poweroff") {
        const witness = await optional(path.join(caseRoot, "host-poweroff.json"));
        const config = await optional(path.join(caseRoot, "worker.json"));
        assert(
          witness?.action === "TurnOff" &&
            witness.vm === "HoneyBee-Setup-QA-20260910" &&
            witness.nonce === config.nonce,
          "Host forced-power-off witness required",
        );
        const interrupted = await optional(path.join(caseRoot, "interrupted.json"));
        assert(
          Date.parse(witness.started) >= Date.parse(interrupted.proof.reachedAt) &&
            Date.parse(witness.completed) <= Date.parse(interrupted.proof.holdDeadline),
          "Host power-off missed the held checkpoint window",
        );
      }
      await run(path.join(installationRoot, "HoneyBeeLauncher.exe"), [], { timeout: 240000 });
      // Launcher performs real startup recovery and Doctor. Verify original
      // pointer bytes, not only the displayed app version or a fixture outcome.
      const config = await optional(path.join(caseRoot, "worker.json"));
      const request = await optional(
        path.join(installationRoot, "update/jobs", config.job.name, "request.json"),
      );
      const pointer = await readFile(path.join(installationRoot, "current.json"));
      assert.equal(sha256(pointer), request.sourcePointerSha256, "Source pointer was not restored");
      return {
        state: "RolledBack",
        automaticLauncherRecovery: true,
        sourcePointerSha256: sha256(pointer),
      };
    },
  };
}
