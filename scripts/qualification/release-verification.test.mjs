import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  classifyTest,
  impact,
  capacity,
  GiB,
  policy,
  summarizeRun,
  cleanupDuplicates,
  digest,
  sourceDigest,
  safeFile,
  versionOnlyManifestChange,
  policyOnlySourceChange,
} from "./release-verification.mjs";
import { fixedAcceptanceGates } from "./final-acceptance.mjs";
import { requireReleaseVerification } from "./release-verify.mjs";
import { runDelta } from "./release-delta.mjs";
import { composeBeta36Native } from "./compose-beta36-native.mjs";
import { beta36DeliveryApprovalId } from "../installation/beta32-delivery-approval.mjs";

const candidate = { setupSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
const source = { commit: "c".repeat(40), inventorySha256: "d".repeat(64) };
test("one-pass import requires all four distinct evidence inputs before writing", async () => {
  await assert.rejects(runDelta([]), /Usage:/u);
  await assert.rejects(
    runDelta([
      "config.json",
      "output/run",
      "--docker",
      "docker.json",
      "--windows",
      "windows.json",
      "--native",
      "native.json",
      "--native",
      "again.json",
    ]),
    /Duplicate or missing evidence input/u,
  );
});
test("native composer refuses evidence paths outside owned output", async () => {
  await assert.rejects(
    composeBeta36Native(
      path.join(tmpdir(), "unowned-input.json"),
      path.join(tmpdir(), "unowned-output.json"),
    ),
    /Evidence paths must stay under output/u,
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hb-verification-"));
  await writeFile(path.join(root, "log.txt"), "real diagnostic log");
  const attachments = [{ path: "log.txt", sha256: digest("real diagnostic log") }];
  const plan = {
    schemaVersion: 1,
    version: "0.1.0-beta.36",
    candidate,
    source,
    baselineCommit: "e".repeat(40),
    baselineRef: "v0.1.0-beta.35",
    dirty: false,
    inventory: { unclassified: [] },
    impact: impact([]),
    requiredRegressions: [],
  };
  const receipts = Object.fromEntries(
    ["docker", "windows", "native"].map((lane) => [
      lane,
      {
        schemaVersion: 1,
        lane,
        source,
        candidate,
        status: "passed",
        environment: "fixture",
        completedAt: "2026-09-20T00:00:00Z",
        attachments,
        imageDigest: "sha256:abc",
        unexpectedSkips: 0,
        updateLaunchPassed: true,
        pendingTransactions: 0,
        coverage: { passed: ["fixture-test"], deferred: [], unexpectedSkips: 0 },
      },
    ]),
  );
  const acceptance = {
    schemaVersion: 1,
    candidate,
    gates: fixedAcceptanceGates.map((id) => ({
      id,
      candidate,
      scope: "final",
      status: "passed",
      evidence: ["log.txt"],
      attachments,
    })),
  };
  return { root, plan, receipts, acceptance };
}
test("one-pass preflight refuses changed evidence before creating a run", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "config.json"), JSON.stringify({ candidate }));
  await writeFile(path.join(f.root, "acceptance.json"), JSON.stringify(f.acceptance));
  for (const lane of ["docker", "windows", "native"]) {
    const receipt = structuredClone(f.receipts[lane]);
    if (lane === "windows") receipt.attachments[0].sha256 = digest("changed");
    await writeFile(path.join(f.root, `${lane}.json`), JSON.stringify(receipt));
  }
  const target = path.join(f.root, "run");
  await assert.rejects(
    runDelta([
      path.join(f.root, "config.json"),
      target,
      "--docker",
      path.join(f.root, "docker.json"),
      "--windows",
      path.join(f.root, "windows.json"),
      "--native",
      path.join(f.root, "native.json"),
      "--acceptance",
      path.join(f.root, "acceptance.json"),
    ]),
    /Evidence changed/u,
  );
  await assert.rejects(readFile(path.join(target, "plan.json")), { code: "ENOENT" });
});
test("one-pass evidence import refuses automatic cleanup", async () => {
  const f = await fixture();
  const config = path.join(f.root, "config.json");
  await writeFile(config, JSON.stringify({ candidate, cleanupManifest: [] }));
  await assert.rejects(
    runDelta([
      config,
      path.join(f.root, "run"),
      "--docker",
      path.join(f.root, "docker.json"),
      "--windows",
      path.join(f.root, "windows.json"),
      "--native",
      path.join(f.root, "native.json"),
      "--acceptance",
      path.join(f.root, "acceptance.json"),
    ]),
    /never performs cleanup/u,
  );
});

test("classification retains Windows-specific Go and rejects unknown PowerShell suites", () => {
  assert.equal(classifyTest("tools/workspace-storage-host/service_windows_test.go"), "windows");
  assert.equal(classifyTest("scripts/new.test.ps1"), "unclassified");
  assert.equal(classifyTest("scripts/qualification/native-evidence.test.ps1"), "docker");
  assert.equal(classifyTest("scripts/new.test.mjs"), "docker+windows");
  assert.equal(classifyTest("other/new.test.ts"), "unclassified");
  assert.equal(classifyTest("scripts/new.test.js"), "unclassified");
  assert.equal(classifyTest("tools/new-module/a_test.go"), "unclassified");
});
test("source identity is stable across Windows checkout line endings", () => {
  assert.equal(sourceDigest(Buffer.from("a\r\nb\r\n")), sourceDigest(Buffer.from("a\nb\n")));
});
test("application change does not force the entire interruption matrix", () => {
  const result = impact(["apps/desktop/src/renderer/main.ts"]);
  assert(result.rerunGates.includes("workspace-preservation"));
  assert(!result.rerunGates.includes("interruption-matrix"));
  assert(result.always.includes("native-update-launch"));
});
test("version-only increments do not invalidate service recovery evidence", () => {
  assert(
    versionOnlyManifestChange(
      '{"version":"0.1.0-beta.35","scripts":{"test":"same"}}',
      '{"version":"0.1.0-beta.36","scripts":{"test":"same"}}',
    ),
  );
  assert(
    !versionOnlyManifestChange(
      '{"version":"0.1.0-beta.35"}',
      '{"version":"0.1.0-beta.36","dependencies":{"new":"1"}}',
    ),
  );
});
test("source equivalence refuses product and package changes", () => {
  assert(
    policyOnlySourceChange([
      "scripts/qualification/release-verification.mjs",
      "docs/operations/release-verification.md",
    ]),
  );
  assert(!policyOnlySourceChange([]));
  assert(!policyOnlySourceChange(["packages/core/src/workspace-storage.ts"]));
  assert(
    !policyOnlySourceChange(["scripts/qualification/release-verification.mjs", "package.json"]),
  );
});
test("change impact selects behavior, while unknown production changes block admission", () => {
  const storage = impact(["integrations/storage/external-bee.patch"]);
  assert(storage.rerunGates.includes("interruption-matrix"));
  assert(storage.rerunGates.includes("capacity-locks"));
  assert(!storage.rerunGates.includes("git-uac"));
  assert(!storage.rerunGates.includes("repair"));
  const publication = impact(["scripts/installation/publish-beta.mjs"]);
  assert.deepEqual(
    new Set(publication.rerunGates),
    new Set(["discovery-download", "artifact-integrity", "signed-setup-winget"]),
  );
  const metadata = impact([
    ".gitattributes",
    ".github/workflows/windows.yml",
    "docs/operations/release-verification.md",
  ]);
  assert.deepEqual(metadata.unclassified, []);
  assert.deepEqual(
    new Set(metadata.rerunGates),
    new Set(["discovery-download", "artifact-integrity", "signed-setup-winget"]),
  );
  const unknown = impact(["new-build-system.config"]);
  assert.deepEqual(unknown.unclassified, ["new-build-system.config"]);
  assert(!unknown.rerunGates.includes("interruption-matrix"));
});
test("capacity admission includes expected growth, guest service floor and child reserve", () => {
  const base = { hostFreeBytes: 60 * GiB, guestFreeBytes: 30 * GiB, vmBytes: 29 * GiB };
  assert(capacity(base, GiB).admitted);
  assert(!capacity(base, 9 * GiB).admitted);
  assert(!capacity({ ...base, hostFreeBytes: 22 * GiB }).admitted);
  assert.throws(() => capacity({ ...base, vmBytes: NaN }));
  assert.equal(policy.checkpointsAllowed, false);
});
test("valid complete evidence is ready but never publishes", async () => {
  const f = await fixture();
  const report = await summarizeRun(f.plan, f.receipts, f.acceptance, f.root);
  assert.equal(report.ready, true);
  assert.equal(report.publicationAllowed, false);
});
test("approved unsigned-beta exception defers only Authenticode, not WinGet or other gates", async () => {
  const f = await fixture();
  f.plan.releaseMode = "unsigned-beta";
  const gate = f.acceptance.gates.find((item) => item.id === "signed-setup-winget");
  Object.assign(gate, { status: "partial", authenticode: "deferred", wingetLocal: "passed" });
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
  gate.wingetLocal = "pending";
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
  gate.wingetLocal = "passed";
  f.plan.releaseMode = "signed";
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
for (const reason of [
  "missing",
  "source",
  "skip",
  "pending",
  "candidate",
  "dirty",
  "unclassified",
  "regression",
]) {
  test(`release refuses ${reason}`, async () => {
    const f = await fixture();
    if (reason === "missing") delete f.receipts.windows;
    if (reason === "source") f.receipts.docker.source = { ...source, commit: "0".repeat(40) };
    if (reason === "skip") f.receipts.windows.unexpectedSkips = 1;
    if (reason === "pending") f.receipts.native.pendingTransactions = 1;
    if (reason === "candidate")
      f.receipts.native.candidate = { ...candidate, setupSha256: "f".repeat(64) };
    if (reason === "dirty") f.plan.dirty = true;
    if (reason === "unclassified") f.plan.inventory.unclassified.push("new.test.ps1");
    if (reason === "regression") f.plan.requiredRegressions.push("native-commit-heartbeat");
    assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
  });
}
test("Docker skip requires a matching pass in its assigned environment", async () => {
  const f = await fixture();
  f.receipts.docker.coverage.deferred.push({ id: "node:windows-case", owner: "windows" });
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
  f.receipts.windows.coverage.passed.push("node:windows-case");
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
});
test("changed evidence blocks release", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "log.txt"), "modified");
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("unhashed or changed current acceptance evidence blocks release", async () => {
  const f = await fixture();
  const gate = f.acceptance.gates.find((item) => item.id === "artifact-integrity");
  delete gate.attachments;
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
  gate.attachments = [{ path: "log.txt", sha256: digest("different") }];
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("affected acceptance gate cannot reuse old evidence", async () => {
  const f = await fixture();
  f.acceptance.gates.find((gate) => gate.id === "artifact-integrity").reuse = {
    reason: "same version",
  };
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("affected composite gate requires candidate-bound delta evidence", async () => {
  const f = await fixture();
  f.plan.impact = impact(["integrations/storage/external-bee.patch"]);
  const original = globalThis.structuredClone(f.acceptance);
  original.sourceCommit = f.plan.baselineCommit;
  original.candidate = { setupSha256: "1".repeat(64), manifestSha256: "2".repeat(64) };
  for (const gate of original.gates) gate.candidate = original.candidate;
  const bytes = JSON.stringify(original);
  await writeFile(path.join(f.root, "baseline.json"), bytes);
  const gate = f.acceptance.gates.find((item) => item.id === "interruption-matrix");
  gate.reuse = {
    reason: "unchanged interruption points",
    environment: "same supported Windows configuration",
    candidate: original.candidate,
    original: { path: "baseline.json", sha256: digest(bytes) },
  };
  gate.delta = { source: f.plan.source, candidate, evidence: ["log.txt"] };
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
  gate.delta.candidate = original.candidate;
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("unaffected gate reuse keeps original candidate and verified baseline binding", async () => {
  const f = await fixture();
  const original = globalThis.structuredClone(f.acceptance);
  original.sourceCommit = f.plan.baselineCommit;
  original.candidate = { setupSha256: "1".repeat(64), manifestSha256: "2".repeat(64) };
  for (const gate of original.gates) gate.candidate = original.candidate;
  const bytes = JSON.stringify(original);
  await writeFile(path.join(f.root, "baseline.json"), bytes);
  f.acceptance.gates.find((gate) => gate.id === "service-rollback").reuse = {
    reason: "service and updater unchanged",
    environment: "same supported Windows configuration",
    original: { path: "baseline.json", sha256: digest(bytes) },
    candidate: original.candidate,
  };
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
  assert.notDeepEqual(original.candidate, f.acceptance.candidate);
});
test("historical acceptance without sourceCommit requires hashed reviewed provenance", async () => {
  const f = await fixture();
  const original = globalThis.structuredClone(f.acceptance);
  original.candidate = { setupSha256: "1".repeat(64), manifestSha256: "2".repeat(64) };
  for (const gate of original.gates) gate.candidate = original.candidate;
  const originalBytes = JSON.stringify(original);
  await writeFile(path.join(f.root, "baseline.json"), originalBytes);
  const completion = { releaseCompleted: true, candidate: original.candidate };
  const completionBytes = JSON.stringify(completion);
  await writeFile(path.join(f.root, "completed.json"), completionBytes);
  const binding = {
    schemaVersion: 1,
    sourceCommit: f.plan.baselineCommit,
    tag: f.plan.baselineRef,
    candidate: original.candidate,
    acceptanceSha256: digest(originalBytes),
    reviewedBy: "release-reviewer",
    reason: "tag and published artifact receipt reviewed",
    releaseCompletion: { path: "completed.json", sha256: digest(completionBytes) },
  };
  const bindingBytes = JSON.stringify(binding);
  await writeFile(path.join(f.root, "binding.json"), bindingBytes);
  const reuse = f.acceptance.gates.find((gate) => gate.id === "service-rollback");
  reuse.reuse = {
    reason: "service update mechanism unchanged",
    environment: "same Windows configuration",
    candidate: original.candidate,
    original: { path: "baseline.json", sha256: digest(originalBytes) },
    baseline: { path: "binding.json", sha256: digest(bindingBytes) },
  };
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
  reuse.reuse.baseline.sha256 = digest("wrong");
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("policy-only source equivalence is native-only and candidate-bound", async () => {
  const f = await fixture();
  const old = { commit: "f".repeat(40), inventorySha256: "1".repeat(64) };
  f.plan.sourceEquivalence = {
    from: old,
    to: f.plan.source,
    changed: ["scripts/qualification/release-verification.mjs"],
  };
  f.receipts.native.source = old;
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, true);
  f.receipts.native.candidate = { ...candidate, setupSha256: "2".repeat(64) };
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
  f.receipts.native.candidate = candidate;
  f.receipts.windows.source = old;
  assert.equal((await summarizeRun(f.plan, f.receipts, f.acceptance, f.root)).ready, false);
});
test("publication recomputes report instead of trusting a ready boolean", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "plan.json"), JSON.stringify(f.plan));
  for (const [lane, receipt] of Object.entries(f.receipts))
    await writeFile(path.join(f.root, `${lane}.json`), JSON.stringify(receipt));
  await writeFile(path.join(f.root, "acceptance.json"), JSON.stringify(f.acceptance));
  const report = await summarizeRun(f.plan, f.receipts, f.acceptance, f.root);
  const reportPath = path.join(f.root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  await requireReleaseVerification(reportPath, candidate, source.commit);
  await writeFile(path.join(f.root, "log.txt"), "tampered");
  await assert.rejects(requireReleaseVerification(reportPath, candidate, source.commit));
});
async function deliveryFixture(change = () => {}) {
  const f = await fixture();
  f.plan.releaseMode = "unsigned-beta";
  f.plan.requiredRegressions = ["issue46-large-cache", "native-commit-heartbeat"];
  f.receipts.native.regressions = [...f.plan.requiredRegressions];
  for (const gate of f.acceptance.gates.filter((g) =>
    ["discovery-download", "signed-setup-winget"].includes(g.id),
  )) {
    Object.assign(gate, {
      status: "partial",
      prePublication: { status: "passed", evidence: ["log.txt"] },
    });
  }
  Object.assign(f.acceptance.gates[3], { publicDelivery: "pending" });
  Object.assign(f.acceptance.gates[15], {
    authenticode: "deferred",
    wingetLocal: "pending",
    wingetManifestValidation: "passed",
  });
  await change(f);
  await writeFile(path.join(f.root, "plan.json"), JSON.stringify(f.plan));
  for (const [lane, receipt] of Object.entries(f.receipts))
    await writeFile(path.join(f.root, `${lane}.json`), JSON.stringify(receipt));
  await writeFile(path.join(f.root, "acceptance.json"), JSON.stringify(f.acceptance));
  const report = await summarizeRun(f.plan, f.receipts, f.acceptance, f.root);
  f.reportPath = path.join(f.root, "report.json");
  await writeFile(f.reportPath, JSON.stringify(report));
  f.approval = {
    schemaVersion: 1,
    id: beta36DeliveryApprovalId,
    version: f.plan.version,
    sourceCommit: source.commit,
    ...candidate,
    wingetManifestSha256: "f".repeat(64),
  };
  return f;
}
test("conditional delivery rechecks all lanes without making the report ready", async () => {
  const f = await deliveryFixture();
  const result = await requireReleaseVerification(
    f.reportPath,
    candidate,
    source.commit,
    "unsigned-beta",
    f.approval,
  );
  assert.equal(result.ready, false);
  assert.equal(result.publicationAllowed, false);
  await assert.rejects(
    requireReleaseVerification(f.reportPath, candidate, source.commit, "unsigned-beta"),
  );
  await assert.rejects(
    requireReleaseVerification(f.reportPath, candidate, source.commit, "unsigned-beta", {
      ...f.approval,
      sourceCommit: "e".repeat(40),
    }),
  );
  await writeFile(path.join(f.root, "log.txt"), "changed");
  await assert.rejects(
    requireReleaseVerification(f.reportPath, candidate, source.commit, "unsigned-beta", f.approval),
  );
});
for (const [name, change] of [
  [
    "dirty source",
    (f) => {
      f.plan.dirty = true;
    },
  ],
  [
    "Windows failure",
    (f) => {
      f.receipts.windows.status = "failed";
    },
  ],
  [
    "native failure",
    (f) => {
      f.receipts.native.status = "failed";
    },
  ],
  [
    "missing large regression",
    (f) => {
      f.receipts.native.regressions = ["native-commit-heartbeat"];
    },
  ],
  [
    "unknown transaction",
    (f) => {
      f.receipts.native.pendingTransactions = 1;
    },
  ],
  [
    "unresolved coverage",
    (f) => {
      f.receipts.docker.coverage.deferred = [{ id: "missing", owner: "windows" }];
    },
  ],
  [
    "third pending gate",
    (f) => {
      f.acceptance.gates[0].status = "pending";
    },
  ],
  [
    "unverified prepublication",
    (f) => {
      f.acceptance.gates[3].prePublication.status = "pending";
    },
  ],
  [
    "invalid reuse",
    (f) => {
      f.acceptance.gates[0].reuse = {
        reason: "same",
        environment: "same",
        original: { path: "absent.json", sha256: "a".repeat(64) },
      };
    },
  ],
])
  test(`conditional delivery rejects ${name}`, async () => {
    const f = await deliveryFixture(change);
    await assert.rejects(
      requireReleaseVerification(
        f.reportPath,
        candidate,
        source.commit,
        "unsigned-beta",
        f.approval,
      ),
    );
  });

async function cleanupFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hb-cleanup-"));
  await mkdir(path.join(root, "transport"));
  await mkdir(path.join(root, "retained"));
  await writeFile(path.join(root, "transport", "payload.zip"), "payload");
  await writeFile(path.join(root, "retained", "payload.zip"), "payload");
  return {
    root,
    entries: [
      {
        path: "transport/payload.zip",
        retainedCopy: "retained/payload.zip",
        sha256: digest("payload"),
      },
    ],
    state: { status: "passed", pendingTransactions: 0, exclusive: true },
  };
}
test("cleanup removes only verified duplicate and retains recoverable copy", async () => {
  const f = await cleanupFixture();
  assert.equal(await cleanupDuplicates(f.root, f.entries, f.state), 1);
  await assert.rejects(readFile(path.join(f.root, "transport/payload.zip")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, "retained/payload.zip"), "utf8"), "payload");
});
for (const reason of ["failed", "pending", "unlocked", "escape", "protected", "changed", "disk"]) {
  test(`cleanup refuses ${reason} without deleting the duplicate`, async () => {
    const f = await cleanupFixture();
    if (reason === "failed") f.state.status = "failed";
    if (reason === "pending") f.state.pendingTransactions = 1;
    if (reason === "unlocked") f.state.exclusive = false;
    if (reason === "escape") f.entries[0].path = "transport/../../payload.zip";
    if (reason === "protected") f.entries[0].protected = true;
    if (reason === "changed") f.entries[0].sha256 = "0".repeat(64);
    if (reason === "disk") f.entries[0].path = "transport/parent.vhdx";
    await assert.rejects(cleanupDuplicates(f.root, f.entries, f.state));
    assert.equal(await readFile(path.join(f.root, "transport/payload.zip"), "utf8"), "payload");
  });
}
test("cleanup refuses directory links including Windows junctions", async () => {
  const f = await cleanupFixture();
  await symlink(
    path.join(f.root, "retained"),
    path.join(f.root, "transport", "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(safeFile(f.root, "transport/link/payload.zip"));
});
