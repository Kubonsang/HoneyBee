import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, open, readFile, writeFile, unlink } from "node:fs/promises";
import {
  publicDeliveryAdmission,
  validateBeta36Approval,
  beta36DeliveryApprovalId,
} from "../installation/beta32-delivery-approval.mjs";
import {
  makePlan,
  readJson,
  summarizeRun,
  digest,
  verifyAttachments,
  cleanupDuplicates,
  git,
} from "./release-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const optional = async (file) =>
  readJson(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const save = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export async function reportRun(directory) {
  const plan = await readJson(path.join(directory, "plan.json"));
  const receipts = {};
  for (const lane of ["docker", "windows", "native"])
    receipts[lane] = await optional(path.join(directory, `${lane}.json`));
  const acceptance = await optional(path.join(directory, "acceptance.json"));
  return summarizeRun(plan, receipts, acceptance, directory);
}

/** Publication re-evaluates hashed evidence; a hand-edited ready:true is not enough. */
export async function requireReleaseVerification(
  reportPath,
  candidate,
  sourceCommit,
  releaseMode = "signed",
  deliveryApproval,
) {
  const supplied = await readJson(reportPath);
  const current = await reportRun(path.dirname(reportPath));
  assert.deepEqual(supplied, current, "Verification report changed or is stale");
  assert.deepEqual(current.candidate, candidate, "Verification candidate mismatch");
  assert.equal(current.source.commit, sourceCommit, "Verification commit mismatch");
  assert.equal(current.releaseMode, releaseMode, "Verification release-mode mismatch");
  if (deliveryApproval) {
    validateBeta36Approval(deliveryApproval, sourceCommit);
    assert.equal(current.version, deliveryApproval.version);
    assert.deepEqual(
      current.blockers,
      ["acceptance: fixed acceptance gates incomplete"],
      "Prepublication requires every source, lane, regression and coverage check",
    );
    const acceptance = await readJson(path.join(path.dirname(reportPath), "acceptance.json"));
    publicDeliveryAdmission(
      { releaseMode },
      acceptance,
      current.version,
      beta36DeliveryApprovalId,
      deliveryApproval,
    );
    // Do not mutate the ordinary report or promote pending gates to passes.
  } else {
    assert.equal(
      current.ready,
      true,
      `Release verification blocked: ${current.blockers.join("; ")}`,
    );
  }
  return current;
}

export async function main(args) {
  const [action, configPath, directoryArg, ...flags] = args;
  assert(
    ["plan", "run", "report"].includes(action) && configPath && directoryArg,
    "Usage: pnpm release:verify -- <plan|run|report> <config.json> <output/run> [--lane docker|windows|native --import receipt.json] [--acceptance acceptance.json]",
  );
  const directory = path.resolve(directoryArg);
  assert(
    directory.startsWith(path.join(root, "output") + path.sep),
    "Run directory must be below repository output/",
  );
  const config = await readJson(configPath);
  const option = (name) => {
    const index = flags.indexOf(name);
    return index < 0 ? null : flags[index + 1];
  };
  for (let i = 0; i < flags.length; i += 2)
    assert(
      ["--lane", "--import", "--acceptance"].includes(flags[i]) && flags[i + 1],
      "Unknown/missing option",
    );
  if (action === "plan") {
    const plan = await makePlan(root, config);
    await mkdir(directory, { recursive: true });
    await save(path.join(directory, "plan.json"), plan);
    await save(path.join(directory, "config.json"), config);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }
  assert.deepEqual(
    config,
    await readJson(path.join(directory, "config.json")),
    "Configuration changed; create a new plan",
  );
  const lock = await open(path.join(directory, "run.lock"), "wx");
  try {
    if (action === "run") {
      const plan = await readJson(path.join(directory, "plan.json"));
      const current = await makePlan(root, config);
      assert.deepEqual(current, plan, "Source/plan changed; create a new run");
      assert.equal(
        plan.inventory.unclassified.length,
        0,
        "Unclassified tests must be assigned first",
      );
      const lane = option("--lane");
      assert(["docker", "windows", "native"].includes(lane), "Explicit execution lane required");
      const target = path.join(directory, `${lane}.json`);
      const previous = await optional(target);
      assert.notEqual(
        previous?.status,
        "passed",
        "Lane already passed; create a new run to replace it",
      );
      let receipt;
      const imported = option("--import");
      if (imported) {
        receipt = await readJson(imported);
        await verifyAttachments(receipt.attachments, path.dirname(path.resolve(imported)));
        receipt.attachments = receipt.attachments.map((entry) => ({
          ...entry,
          path: path.resolve(path.dirname(imported), entry.path),
        }));
      } else {
        assert.equal(
          lane,
          "docker",
          "Windows runs in GitHub Actions; native receipts come from the real VM, never a simulated pass",
        );
        const { runDocker } = await import("../../tests/docker/run.mjs");
        receipt = await runDocker({
          root,
          directory: path.join(directory, `docker-${Date.now()}`),
          source: plan.source,
        });
        receipt.attachments = receipt.attachments.map((entry) => ({
          ...entry,
          path: path.resolve(receipt.evidenceDirectory, entry.path),
        }));
      }
      assert.equal(receipt.lane, lane);
      assert.deepEqual(receipt.source, plan.source, "Imported source identity mismatch");
      if (previous) {
        // Preserve failed attempts; successful evidence cannot be silently replaced.
        assert.notEqual(
          previous.status,
          "passed",
          "Lane already passed; make a new run to replace evidence",
        );
        await save(path.join(directory, `${lane}-${Date.now()}-previous.json`), previous);
        await unlink(target);
      }
      await save(target, receipt);
    }
    if (option("--acceptance")) {
      const file = path.resolve(option("--acceptance"));
      const acceptance = await readJson(file);
      for (const gate of acceptance.gates ?? [])
        if (gate.reuse?.original?.path)
          gate.reuse.original.path = path.resolve(path.dirname(file), gate.reuse.original.path);
      await save(path.join(directory, "acceptance.json"), acceptance);
    }
    const report = await reportRun(directory);
    if (
      report.ready &&
      config.cleanupManifest &&
      !(await optional(path.join(directory, "cleanup-completed.json")))
    ) {
      const native = await readJson(path.join(directory, "native.json"));
      await cleanupDuplicates(directory, config.cleanupManifest, {
        status: native.status,
        pendingTransactions: native.pendingTransactions,
        exclusive: true,
      });
    }
    // Reports are derived views; raw receipts and attempts are never overwritten.
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.ready) process.exitCode = 1;
  } finally {
    await lock.close();
    await unlink(path.join(directory, "run.lock"));
  }
}

export async function candidateConfig(directory, baselineRef = "v0.1.0-beta.35") {
  const manifest = await readJson(path.join(directory, "release.json"));
  return {
    schemaVersion: 1,
    version: manifest.version,
    sourceCommit: git(root, ["rev-parse", "HEAD"]),
    baselineRef,
    candidate: {
      setupSha256: digest(await readFile(path.join(directory, "HoneyBeeSetup.exe"))),
      manifestSha256: digest(await readFile(path.join(directory, "release.json"))),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2).filter((arg) => arg !== "--")).catch((error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
  });
}
