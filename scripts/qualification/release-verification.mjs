import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
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
export const digestFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
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

// Every candidate has new distribution bytes/URLs, but historical interactive
// journeys are invalidated only by the behavior that changed.
const routine = ["discovery-download", "artifact-integrity", "signed-setup-winget"];
const storageGates = [
  "service-migration",
  "workspace-preservation",
  "drain-duplicates",
  "capacity-locks",
  "interruption-matrix",
];
const publicationGates = ["discovery-download", "artifact-integrity", "signed-setup-winget"];
export function impact(files) {
  const gates = new Set(routine);
  const reasons = [];
  const unclassified = [];
  for (const file of files) {
    if (
      /^(docs\/|tests\/|\.github\/|scripts\/(qualification|test-support)\/)|(^|\/)(README\.md|[^/]+\.test\.[^/]+|[^/]+_test\.go)$|^\.(gitattributes|gitignore)$/u.test(
        file,
      )
    )
      continue;
    if (
      /^(integrations\/storage\/|tools\/workspace-storage-host\/)|^packages\/core\/src\/workspace-(storage|core|types)/u.test(
        file,
      )
    ) {
      storageGates.forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "storage" });
    } else if (
      /^apps\/desktop\/resources\/component-compatibility-v1\.json$|^apps\/desktop\/scripts\/prepare-tools\.mjs$/u.test(
        file,
      )
    ) {
      ["compatibility-floors", "artifact-integrity", "signed-setup-winget"].forEach((gate) =>
        gates.add(gate),
      );
      reasons.push({ file, scope: "component-packaging" });
    } else if (/^apps\/desktop\/src\/renderer\/(operation-errors|i18n)\.ts$/u.test(file)) {
      gates.add("interruption-matrix");
      reasons.push({ file, scope: "commit-guidance" });
    } else if (
      /^scripts\/installation\/(beta32-delivery-approval|complete-public-beta|publish-beta|review-distribution)\.mjs$/u.test(
        file,
      )
    ) {
      publicationGates.forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "publication" });
    } else if (
      /^scripts\/(installation|update|recovery)\/|^tools\/honeybee-(launcher|update-package)\//u.test(
        file,
      )
    ) {
      fixedAcceptanceGates.forEach((gate) => gates.add(gate));
      reasons.push({ file, scope: "installation-update" });
    } else if (/^apps\/cli\/scripts\/smoke\.mjs$/u.test(file)) {
      continue;
    } else if (/^(apps\/|packages\/)/u.test(file)) {
      gates.add("workspace-preservation");
      reasons.push({ file, scope: "application" });
    } else if (file === "package.json" || file.endsWith("/package.json")) {
      gates.add("artifact-integrity");
      reasons.push({ file, scope: "build-manifest" });
    } else {
      unclassified.push(file);
      reasons.push({ file, scope: "unclassified-production" });
    }
  }
  return {
    rerunGates: [...gates],
    reasons,
    unclassified,
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

export function policyOnlySourceChange(files) {
  return (
    files.length > 0 && files.every((file) => /^(scripts\/qualification\/|docs\/)/u.test(file))
  );
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
  let sourceEquivalence;
  if (config.sourceEquivalence) {
    const previous = config.sourceEquivalence;
    assert(/^[a-f0-9]{40}$/u.test(previous.commit), "Equivalent source commit required");
    assert(
      /^[a-f0-9]{64}$/u.test(previous.inventorySha256),
      "Equivalent source inventory required",
    );
    git(root, ["merge-base", "--is-ancestor", previous.commit, config.sourceCommit]);
    const changed = git(root, ["diff", "--name-only", previous.commit, config.sourceCommit, "--"])
      .split("\n")
      .filter(Boolean);
    assert(
      policyOnlySourceChange(changed),
      "Equivalent source changed a product or packaging input",
    );
    assert(config.candidate, "Equivalent source requires frozen candidate hashes");
    const distribution = path.resolve(root, previous.distributionDirectory ?? "");
    assert(
      distribution.startsWith(path.join(root, "output") + path.sep),
      "Equivalent source distribution must be under output",
    );
    assert((await lstat(distribution)).isDirectory(), "Equivalent source distribution missing");
    assert(
      (await realpath(distribution)).startsWith(
        (await realpath(path.join(root, "output"))) + path.sep,
      ),
      "Equivalent source distribution resolves outside output",
    );
    const setupPath = path.join(distribution, "HoneyBeeSetup.exe");
    const manifestPath = path.join(distribution, "release.json");
    const applicationPath = path.join(distribution, "application.zip");
    for (const file of [setupPath, manifestPath, applicationPath])
      assert((await lstat(file)).isFile(), "Equivalent source artifact missing or linked");
    assert.equal(
      await digestFile(setupPath),
      config.candidate.setupSha256,
      "Equivalent Setup changed",
    );
    assert.equal(
      await digestFile(manifestPath),
      config.candidate.manifestSha256,
      "Equivalent manifest changed",
    );
    const manifest = await readJson(manifestPath);
    assert.equal(
      await digestFile(applicationPath),
      manifest.packages?.application?.sha256,
      "Equivalent application changed",
    );
    sourceEquivalence = {
      from: { commit: previous.commit, inventorySha256: previous.inventorySha256 },
      to: { commit: config.sourceCommit, inventorySha256: source.sha256 },
      changed,
    };
  }
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
    ...(sourceEquivalence ? { sourceEquivalence } : {}),
    baselineCommit,
    baselineRef: config.baselineRef,
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
  if (plan.impact.unclassified?.length) blockers.push("unclassified-production-change");
  const lanes = [];
  for (const lane of ["docker", "windows", "native"]) {
    const receipt = receipts[lane];
    let error;
    try {
      assert(receipt, "not executed/imported");
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.lane, lane);
      const equivalentNative =
        lane === "native" &&
        plan.sourceEquivalence &&
        JSON.stringify(plan.sourceEquivalence.from) === JSON.stringify(receipt.source) &&
        JSON.stringify(plan.sourceEquivalence.to) === JSON.stringify(plan.source) &&
        JSON.stringify(receipt.candidate) === JSON.stringify(plan.candidate);
      if (!equivalentNative) assert.deepEqual(receipt.source, plan.source, "source mismatch");
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
      const affected = plan.impact.rerunGates.includes(gate.id);
      if (["passed", "partial"].includes(gate.status) && (affected || !gate.reuse)) {
        await verifyAttachments(gate.attachments, base);
        assert(
          gate.attachments.some((item) => gate.evidence.includes(item.path)),
          "current gate evidence does not name a hashed attachment",
        );
      }
      if (!gate.reuse) continue;
      if (affected) {
        assert(gate.delta, `affected gate cannot be reused alone: ${gate.id}`);
        assert.deepEqual(gate.delta.source, plan.source, "delta source mismatch");
        assert.deepEqual(gate.delta.candidate, plan.candidate, "delta candidate mismatch");
        assert(
          Array.isArray(gate.delta.evidence) &&
            gate.delta.evidence.length > 0 &&
            gate.delta.evidence.every(
              (item) =>
                gate.evidence.includes(item) &&
                gate.attachments.some((attachment) => attachment.path === item),
            ),
          "affected gate needs current evidence",
        );
      }
      assert(gate.reuse.reason && gate.reuse.environment, "reuse rationale/environment required");
      await verifyAttachments([gate.reuse.original], base);
      const original = await readJson(path.resolve(base, gate.reuse.original.path));
      assert(
        summarizeFinalAcceptance(original).gates.find((item) => item.id === gate.id)?.status ===
          "passed",
        "original gate did not pass",
      );
      assert.deepEqual(original.candidate, gate.reuse.candidate, "reuse candidate mismatch");
      if (original.sourceCommit) {
        assert.equal(original.sourceCommit, plan.baselineCommit, "reuse baseline mismatch");
      } else {
        // Older accepted ledgers did not record sourceCommit. Never rewrite the
        // original: require a separately hashed, reviewed provenance record.
        assert(gate.reuse.baseline, "historical reuse provenance missing");
        await verifyAttachments([gate.reuse.baseline], base);
        const binding = await readJson(path.resolve(base, gate.reuse.baseline.path));
        assert.equal(binding.schemaVersion, 1);
        assert.equal(binding.sourceCommit, plan.baselineCommit, "reuse baseline mismatch");
        assert.equal(binding.tag, plan.baselineRef, "reuse baseline tag mismatch");
        assert.deepEqual(
          binding.candidate,
          original.candidate,
          "reuse provenance candidate mismatch",
        );
        assert.equal(
          binding.acceptanceSha256,
          gate.reuse.original.sha256,
          "reuse provenance acceptance mismatch",
        );
        assert(binding.reviewedBy && binding.reason, "reuse provenance review missing");
        assert(binding.releaseCompletion, "reuse publication provenance missing");
        await verifyAttachments(
          [binding.releaseCompletion],
          path.dirname(path.resolve(base, gate.reuse.baseline.path)),
        );
        const completion = await readJson(
          path.resolve(
            path.dirname(path.resolve(base, gate.reuse.baseline.path)),
            binding.releaseCompletion.path,
          ),
        );
        assert.equal(completion.releaseCompleted, true, "baseline publication incomplete");
        assert.deepEqual(
          completion.candidate,
          original.candidate,
          "baseline publication candidate mismatch",
        );
      }
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
