import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, lstat, realpath, readdir, unlink, writeFile, statfs } from "node:fs/promises";
import path from "node:path";
import { fixedAcceptanceGates, summarizeFinalAcceptance } from "./final-acceptance.mjs";
import { distributionReadiness } from "../installation/distribution-policy.mjs";

export const GiB = 1024 ** 3;
export const policy = Object.freeze({
  schemaVersion: 1,
  vmCount: 1,
  vmVirtualBytes: 64 * GiB,
  vmBudgetBytes: 40 * GiB,
  vmPauseBytes: 38 * GiB,
  hostFloorBytes: 20 * GiB,
  hostPauseFreeBytes: 22 * GiB,
  guestFloorBytes: 20 * GiB,
  childReserveBytes: 2 * GiB,
  builderCacheTargetBytes: 8 * GiB,
  checkpointsAllowed: false,
  automaticExpansionAllowed: false,
});
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourceDigest = (bytes) =>
  digest(isUtf8(bytes) ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes);
export const readJson = async (file) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
export const git = (root, args) =>
  execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 ** 2,
  }).trim();

export function classifyTest(file) {
  if (file.endsWith(".test.ps1")) {
    if (/\/(native-fault-baseline|native-evidence)\.test\.ps1$/u.test(file)) return "docker";
    if (file.endsWith("/inspect-integrated-guest.test.ps1")) return "windows";
    return "unclassified";
  }
  if (/^tools\/(workspace-storage-host|honeybee-launcher|honeybee-update-package)\//u.test(file)) {
    if (file.endsWith("_windows_test.go")) return "windows";
    if (file.endsWith("_test.go")) return "docker+windows";
  }
  if (/^(apps|packages)\/.*\.test\.ts$/u.test(file) || /^scripts\/.*\.test\.mjs$/u.test(file))
    return "docker+windows";
  if (/^scripts\/benchmarks\/vhdx\/test_.*\.py$/u.test(file)) return "docker";
  return "unclassified";
}

// Windows remains a superset until the recorded skip/platform inventory proves
// that narrowing it cannot drop coverage. No new test silently disappears.
export async function inventory(root) {
  const names = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const files = [];
  for (const file of [...new Set(names)].sort()) {
    if (
      !/^(apps\/(cli|desktop)\/|packages\/|scripts\/|tools\/|integrations\/|docs\/|tests\/|\.github\/|[^/]+$)/u.test(
        file,
      )
    )
      continue;
    if (
      /(^|\/)(node_modules|dist|output|private|secrets|\.secrets)(\/|$)|(^|\/)(\.env[^/]*|\.npmrc|\.pnpmrc|credentials[^/]*)$|\.(exe|dll|zip|vhdx|iso|pem|key|pfx|docx)$/iu.test(
        file,
      )
    )
      continue;
    const absolute = path.join(root, file);
    const info = await lstat(absolute).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) continue; // deleted tracked input is represented by its absence
    assert(info.isFile() && !info.isSymbolicLink(), `Non-regular source input: ${file}`);
    files.push({ file, sha256: sourceDigest(await readFile(absolute)) });
  }
  const tests = [...new Set(names)]
    .filter((file) => /\.test\.([cm]?[jt]sx?|ps1)$|_test\.go$|\/test_[^/]+\.py$/u.test(file))
    .map((file) => ({ file, lane: classifyTest(file) }));
  return {
    files,
    tests,
    sha256: digest(JSON.stringify(files)),
    unclassified: tests.filter((test) => test.lane === "unclassified"),
  };
}

const routine = ["discovery-download", "artifact-integrity", "signed-setup-winget"];
export function impact(files) {
  const gates = new Set(routine);
  const reasons = [];
  for (const file of files) {
    if (/^(docs\/|tests\/|scripts\/(qualification|test-support)\/)|\.(md|test\.[^/]+)$/u.test(file))
      continue;
    if (
      /^(integrations\/storage\/|tools\/workspace-storage-host\/)|^packages\/core\/src\/workspace-(storage|core|types)/u.test(
        file,
      )
    ) {
      [
        "service-migration",
        "workspace-preservation",
        "service-rollback",
        "drain-duplicates",
        "compatibility-floors",
        "capacity-locks",
        "repair",
        "interruption-matrix",
      ].forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "storage" });
    } else if (
      /^scripts\/(installation|update|recovery)\/|^tools\/honeybee-(launcher|update-package)\//u.test(
        file,
      )
    ) {
      fixedAcceptanceGates.forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "installation-update" });
    } else if (/^(apps\/|packages\/)/u.test(file)) {
      gates.add("workspace-preservation");
      reasons.push({ file, scope: "application" });
    } else {
      fixedAcceptanceGates.forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "unknown-conservative" });
    }
  }
  return {
    rerunGates: [...gates],
    reasons,
    always: ["docker", "windows", "native-update-launch", "distribution"],
  };
}

export function versionOnlyManifestChange(before, after) {
  try {
    const left = JSON.parse(before),
      right = JSON.parse(after);
    if (left.version === right.version) return false;
    delete left.version;
    delete right.version;
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

export function capacity(snapshot, expectedGrowthBytes = 0) {
  const problems = [];
  for (const key of ["hostFreeBytes", "guestFreeBytes", "vmBytes"])
    assert(Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0, `Invalid ${key}`);
  assert(Number.isSafeInteger(expectedGrowthBytes) && expectedGrowthBytes >= 0);
  if (snapshot.hostFreeBytes - expectedGrowthBytes <= policy.hostPauseFreeBytes)
    problems.push("host-headroom");
  if (snapshot.vmBytes + expectedGrowthBytes >= policy.vmPauseBytes) problems.push("vm-budget");
  if (
    snapshot.guestFreeBytes - expectedGrowthBytes <
    policy.guestFloorBytes + policy.childReserveBytes
  )
    problems.push("guest-headroom");
  return { admitted: problems.length === 0, problems, policy, expectedGrowthBytes };
}

export async function makePlan(root, config) {
  assert.equal(config.schemaVersion, 1);
  assert(
    ["signed", "unsigned-beta"].includes(config.releaseMode ?? "signed"),
    "Invalid release mode",
  );
  if (config.releaseMode === "unsigned-beta")
    assert(/-beta\.\d+$/u.test(config.version), "Unsigned exception is beta-only");
  assert(/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(config.version), "Candidate version required");
  assert(
    !/^0\.1\.0-beta\.(?:[0-9]|[12][0-9]|3[0-5])$/u.test(config.version),
    "Candidate must be newer than beta.35",
  );
  if (config.candidate)
    for (const key of ["setupSha256", "manifestSha256"])
      assert(/^[a-f0-9]{64}$/u.test(config.candidate[key]), `Invalid ${key}`);
  assert(/^[a-f0-9]{40}$/u.test(config.sourceCommit), "Full source commit required");
  assert.equal(
    git(root, ["rev-parse", "HEAD"]),
    config.sourceCommit,
    "Source commit differs from checkout",
  );
  assert(config.baselineRef && !config.baselineRef.startsWith("-"), "Baseline ref required");
  const baselineCommit = git(root, ["rev-parse", `${config.baselineRef}^{commit}`]);
  git(root, ["merge-base", "--is-ancestor", baselineCommit, config.sourceCommit]);
  // All candidates in this series must retain the user's beta.35 source floor.
  git(root, ["merge-base", "--is-ancestor", "v0.1.0-beta.35", config.sourceCommit]);
  const source = await inventory(root);
  const changedFiles = [
    ...new Set(
      [
        ...git(root, ["diff", "--name-only", baselineCommit, "--"]).split("\n"),
        ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
      ].filter(Boolean),
    ),
  ];
  const impactFiles = [];
  for (const file of changedFiles) {
    if (file === "package.json" || file.endsWith("/package.json")) {
      try {
        if (
          versionOnlyManifestChange(
            git(root, ["show", `${baselineCommit}:${file}`]),
            await readFile(path.join(root, file), "utf8"),
          )
        )
          continue;
      } catch {
        /* Missing/renamed manifest requires normal conservative classification. */
      }
    }
    impactFiles.push(file);
  }
  return {
    schemaVersion: 1,
    version: config.version,
    releaseMode: config.releaseMode ?? "signed",
    source: { commit: config.sourceCommit, inventorySha256: source.sha256 },
    baselineCommit,
    candidate: config.candidate ?? null,
    dirty: git(root, ["status", "--porcelain", "--untracked-files=normal"]).length > 0,
    inventory: source,
    impact: impact(impactFiles),
    policy,
    requiredRegressions: [
      ...new Set([
        ...(config.requiredRegressions ?? []),
        ...(impact(impactFiles).reasons.some((reason) => reason.scope === "storage")
          ? ["native-commit-heartbeat"]
          : []),
      ]),
    ],
    publicationAllowed: false,
  };
}

export async function verifyAttachments(entries, base) {
  assert(Array.isArray(entries) && entries.length > 0, "Evidence attachments required");
  for (const entry of entries) {
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256), "Evidence digest required");
    const file = path.resolve(base, entry.path);
    assert((await lstat(file)).isFile(), "Evidence must be a file");
    assert.equal(digest(await readFile(file)), entry.sha256, `Evidence changed: ${entry.path}`);
  }
}

export async function summarizeRun(plan, receipts, acceptance, base) {
  const blockers = [];
  if (plan.dirty) blockers.push("release-source-is-dirty");
  if (!plan.candidate) blockers.push("candidate-not-frozen");
  if (plan.inventory.unclassified.length) blockers.push("unclassified-tests");
  const lanes = [];
  for (const lane of ["docker", "windows", "native"]) {
    const receipt = receipts[lane];
    let error;
    try {
      assert(receipt, "not executed/imported");
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.lane, lane);
      assert.deepEqual(receipt.source, plan.source, "source mismatch");
      assert.equal(receipt.status, "passed", "lane not passed");
      assert.equal(receipt.unexpectedSkips, 0, "unowned skips");
      if (lane !== "native") {
        assert(receipt.coverage?.passed?.length > 0, "test coverage missing");
        assert.equal(receipt.coverage.unexpectedSkips, 0, "unexpected coverage outcomes");
      }
      assert(receipt.environment && receipt.completedAt, "environment/time missing");
      await verifyAttachments(receipt.attachments, base);
      if (lane === "docker") assert(receipt.imageDigest, "image identity missing");
      if (lane === "native") {
        assert(plan.candidate, "candidate not frozen");
        assert.deepEqual(receipt.candidate, plan.candidate, "candidate mismatch");
        assert.equal(receipt.updateLaunchPassed, true, "real update/launch missing");
        assert.equal(receipt.pendingTransactions, 0, "transaction outcome unknown");
        for (const id of plan.requiredRegressions)
          assert(receipt.regressions?.includes(id), `regression missing: ${id}`);
      }
    } catch (failure) {
      error = failure.message;
    }
    if (error) blockers.push(`${lane}: ${error}`);
    lanes.push({ lane, status: error ? "blocked" : "passed", ...(error ? { reason: error } : {}) });
  }
  for (const lane of ["docker", "windows"])
    for (const skipped of receipts[lane]?.coverage?.deferred ?? []) {
      const owner = receipts[skipped.owner];
      const nativeFallback =
        skipped.owner === "windows" &&
        receipts.windows?.coverage?.deferred?.some(
          (item) => item.id === skipped.id && item.owner === "native",
        ) &&
        receipts.native?.coverage?.passed?.includes(skipped.id);
      if (!owner?.coverage?.passed?.includes(skipped.id) && !nativeFallback)
        blockers.push(`unresolved-deferred-test: ${skipped.id} -> ${skipped.owner}`);
    }
  try {
    assert(acceptance, "final acceptance missing");
    assert.deepEqual(acceptance.candidate, plan.candidate, "acceptance candidate mismatch");
    const final = summarizeFinalAcceptance(acceptance);
    const readiness = distributionReadiness({ releaseMode: plan.releaseMode ?? "signed" }, final);
    for (const gate of acceptance.gates) {
      if (!gate.reuse) continue;
      assert(
        !plan.impact.rerunGates.includes(gate.id),
        `affected gate cannot be reused: ${gate.id}`,
      );
      assert(gate.reuse.reason && gate.reuse.environment, "reuse rationale/environment required");
      await verifyAttachments([gate.reuse.original], base);
      const original = await readJson(path.resolve(base, gate.reuse.original.path));
      assert(
        summarizeFinalAcceptance(original).gates.find((item) => item.id === gate.id)?.status ===
          "passed",
        "original gate did not pass",
      );
      assert.equal(original.sourceCommit, plan.baselineCommit, "reuse baseline mismatch");
    }
    // Validate reuse even when delivery checks are pending. Otherwise a
    // prepublication-only admission could hide invalid reused evidence.
    assert(
      readiness.signedReleaseReady || readiness.unsignedBetaReady,
      "fixed acceptance gates incomplete",
    );
  } catch (failure) {
    blockers.push(`acceptance: ${failure.message}`);
  }
  return {
    schemaVersion: 1,
    version: plan.version,
    releaseMode: plan.releaseMode ?? "signed",
    source: plan.source,
    candidate: plan.candidate,
    lanes,
    blockers,
    ready: blockers.length === 0,
    publicationAllowed: false,
  };
}

// Only per-run, enumerated duplicate transport/context files are eligible. No
// recursive deletion, package retention expiry, or transaction/store cleanup.
export async function safeFile(root, relative) {
  assert(relative && !path.isAbsolute(relative), "Relative cleanup path required");
  const absolute = path.resolve(root, relative);
  const resolvedRoot = await realpath(root);
  assert(!(await lstat(root)).isSymbolicLink(), "Cleanup root link refused");
  assert(absolute.startsWith(path.resolve(root) + path.sep), "Path escapes run");
  let cursor = path.resolve(root);
  for (const part of path.relative(root, absolute).split(path.sep)) {
    cursor = path.join(cursor, part);
    assert(!(await lstat(cursor)).isSymbolicLink(), "Cleanup link refused");
  }
  assert(
    (await realpath(absolute)).startsWith(resolvedRoot + path.sep),
    "Resolved path escapes run",
  );
  assert((await lstat(absolute)).isFile(), "Cleanup requires a regular file");
  return absolute;
}

export async function cleanupDuplicates(root, manifest, state) {
  assert(
    state.status === "passed" && state.pendingTransactions === 0 && state.exclusive === true,
    "Cleanup requires terminal successful exclusive run",
  );
  const intent = [];
  for (const entry of manifest) {
    assert(
      /^(transport|context)\//u.test(entry.path),
      "Only registered temporary copies may be removed",
    );
    assert(!/\.(vhdx?|avhdx?|iso)$/iu.test(entry.path), "Disk/media cleanup prohibited");
    assert(!entry.protected && entry.retainedCopy, "Protected/missing retained copy");
    const file = await safeFile(root, entry.path);
    const retained = await safeFile(root, entry.retainedCopy);
    assert(!/^(transport|context)\//u.test(entry.retainedCopy), "Retained copy is temporary");
    assert.equal(digest(await readFile(file)), entry.sha256);
    assert.equal(digest(await readFile(retained)), entry.sha256);
    intent.push({ ...entry, file });
  }
  await writeFile(path.join(root, "cleanup-intent.json"), JSON.stringify(intent, null, 2), {
    flag: "wx",
  });
  for (const entry of intent) {
    const file = await safeFile(root, entry.path);
    assert.equal(
      digest(await readFile(file)),
      entry.sha256,
      "Temporary file changed before cleanup",
    );
    await unlink(file);
  }
  await writeFile(
    path.join(root, "cleanup-completed.json"),
    JSON.stringify({
      removed: intent.map((item) => item.path),
      recoverableFromRetainedCopies: true,
    }),
    { flag: "wx" },
  );
  return intent.length;
}

export async function hostSpace(root) {
  const fs = await statfs(root);
  return fs.bavail * fs.bsize;
}

export async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "VM directory links refused");
    const file = path.join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(file) : (await lstat(file)).size;
  }
  return bytes;
}
