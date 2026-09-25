import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  beta32DeliveryApproval,
  beta35DeliveryApproval,
  beta36DeliveryApprovalId,
  loadDeliveryApproval,
} from "./beta32-delivery-approval.mjs";
import { requireReleaseVerification } from "../qualification/release-verify.mjs";
import { reviewDistribution } from "./review-distribution.mjs";
import { digestDistributionFile } from "./prepare-distribution.mjs";
import { readBounded } from "../update/prepare-release.mjs";

// Completes the approved two-phase publication. It never marks a QA gate passed.
// The operator records the actual Desktop/WinGet results before invoking this.
const [config, finalNotesPath] = process.argv.slice(2);
assert(
  config && finalNotesPath,
  "Usage: complete-public-beta.mjs <review-config.json> <final-notes.md>",
);
const options = JSON.parse(await readBounded(config, 64 * 1024));
const approval = await loadDeliveryApproval(options);
assert(approval, "Unknown public delivery approval");
const finalOptions = { ...options };
delete finalOptions.deliveryApproval;
const repository = "Kubonsang/HoneyBee";
const tag = `v${approval.version}`;
const commit =
  approval === beta32DeliveryApproval
    ? "67c1712e6fcf846a9179b5ea595cf0807950f844"
    : options.releaseCommit;
assert(/^[a-f0-9]{40}$/.test(commit), "Pinned release source commit required");
if (approval.id === beta36DeliveryApprovalId) assert.equal(commit, approval.sourceCommit);
const assets = [
  "HoneyBeeSetup.exe",
  "application.zip",
  "release.json",
  "release.sig.json",
  "SHA256SUMS.txt",
];
if (approval === beta35DeliveryApproval || approval.id === beta36DeliveryApprovalId) {
  assert.equal(
    (await digestDistributionFile(path.join(options.directory, "Kubonsang.HoneyBee.yaml"))).sha256,
    approval.wingetManifestSha256,
  );
  assets.push("Kubonsang.HoneyBee.yaml");
}
const gh = async (args) =>
  (await promisify(execFile)("gh", args, { windowsHide: true, timeout: 60000 })).stdout;
const remote = JSON.parse(
  await gh([
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "isDraft,isPrerelease,targetCommitish,assets,url",
  ]),
);
assert.equal(remote.isDraft, false);
assert.equal(remote.isPrerelease, true);
assert.equal(remote.targetCommitish, commit);
const base = path.join(path.resolve(options.directory), "publication");
await mkdir(base, { recursive: true });
const attempt = await mkdtemp(path.join(base, "public-verification-"));
const hashes = {};
try {
  assert.deepEqual(remote.assets.map((a) => a.name).sort(), [...assets].sort());
  const review = await reviewDistribution(finalOptions);
  assert.equal(review.candidate.setupSha256, approval.setupSha256);
  assert.equal(review.candidate.manifestSha256, approval.manifestSha256);
  if (approval.id === beta36DeliveryApprovalId) {
    assert(options.verificationReportPath, "Unified release verification required");
    await requireReleaseVerification(
      options.verificationReportPath,
      review.candidate,
      commit,
      review.releaseMode,
    );
  }
  assert.equal(
    review.unsignedBetaReady,
    true,
    "Public Desktop/WinGet or other acceptance remains incomplete",
  );
  const notes = (await readBounded(finalNotesPath, 256 * 1024)).toString("utf8");
  assert(notes.includes("Windows Authenticode: not signed"), "Unsigned disclosure required");
  assert(
    notes.includes("beta.11/hb12") && notes.includes("not supported"),
    "Legacy migration limitation required",
  );
  assert(!notes.includes("Draft only"), "Final notes still describe a draft");
  assert(
    !notes.includes("Public delivery verification pending"),
    "Final notes still describe pending delivery",
  );
  for (const name of assets) {
    const expected = await digestDistributionFile(path.join(options.directory, name));
    const response = await globalThis.fetch(
      `https://github.com/${repository}/releases/download/${tag}/${name}`,
      { signal: globalThis.AbortSignal.timeout(600000) },
    );
    assert.equal(response.status, 200, `${name}: anonymous download failed`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > expected.size) {
        await response.body.cancel().catch(() => {});
        throw Error(`${name}: response too large`);
      }
      hash.update(bytes);
    }
    hashes[name] = { sha256: hash.digest("hex"), size };
    assert.deepEqual(hashes[name], expected, `${name}: public artifact differs`);
  }
  assert.deepEqual(
    await reviewDistribution(finalOptions),
    review,
    "Acceptance changed during public verification",
  );
  const exactNotes = path.join(attempt, "final-notes.md");
  if (approval.id === beta36DeliveryApprovalId) {
    assert.deepEqual(await loadDeliveryApproval(options), approval, "Delivery approval changed");
    await requireReleaseVerification(
      options.verificationReportPath,
      review.candidate,
      commit,
      review.releaseMode,
    );
  }
  await writeFile(exactNotes, notes, { flag: "wx" });
  await gh(["release", "edit", tag, "--repo", repository, "--notes-file", exactNotes]);
  const publishedNotes = JSON.parse(
    await gh(["release", "view", tag, "--repo", repository, "--json", "body"]),
  );
  assert.equal(
    publishedNotes.body.replaceAll("\r\n", "\n").trimEnd(),
    notes.replaceAll("\r\n", "\n").trimEnd(),
  );
  const result = {
    schemaVersion: 1,
    releaseCompleted: true,
    url: remote.url,
    candidate: review.candidate,
    hashes,
    unsignedBetaReady: true,
  };
  await writeFile(path.join(attempt, "completed.json"), JSON.stringify(result, null, 2), {
    flag: "wx",
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  const result = {
    schemaVersion: 1,
    releaseCompleted: false,
    error: String(error),
    withdrawn: false,
    hashes,
  };
  try {
    await gh(["release", "edit", tag, "--repo", repository, "--draft=true"]);
    const state = JSON.parse(
      await gh(["release", "view", tag, "--repo", repository, "--json", "isDraft"]),
    );
    assert.equal(state.isDraft, true);
    result.withdrawn = true;
  } catch (withdrawalError) {
    result.withdrawalError = String(withdrawalError);
  }
  await writeFile(path.join(attempt, "failed.json"), JSON.stringify(result, null, 2), {
    flag: "wx",
  });
  throw error;
}
