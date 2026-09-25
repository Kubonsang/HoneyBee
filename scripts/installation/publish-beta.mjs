import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { reviewDistribution } from "./review-distribution.mjs";
import { digestDistributionFile } from "./prepare-distribution.mjs";
import { assertDistributionActionAllowed } from "./distribution-policy.mjs";
import { readBounded } from "../update/prepare-release.mjs";
import {
  beta35DeliveryApproval,
  beta36DeliveryApprovalId,
  loadDeliveryApproval,
} from "./beta32-delivery-approval.mjs";
import { requireReleaseVerification } from "../qualification/release-verify.mjs";

const [configPath, notesPath, commit, action] = process.argv.slice(2);
assert(
  configPath &&
    notesPath &&
    /^[a-f0-9]{40}$/u.test(commit) &&
    ["stage", "publish", "publish-for-verification"].includes(action),
  "Usage: publish-beta.mjs <review-config.json> <release-notes.md> <full-remote-commit> <stage|publish|publish-for-verification>",
);
const options = JSON.parse(await readBounded(configPath, 64 * 1024));
const deliveryApproval = await loadDeliveryApproval(options);
if (deliveryApproval?.id === beta36DeliveryApprovalId)
  assert.equal(deliveryApproval.sourceCommit, commit, "Approved publication commit differs");
const review = await reviewDistribution(options);
assertDistributionActionAllowed(review, action);
const distribution = path.resolve(options.directory);
const receipt = JSON.parse(
  await readBounded(path.join(distribution, "distribution.json"), 64 * 1024),
);
assert.equal(receipt.channel, "beta");
if (
  ["publish", "publish-for-verification"].includes(action) &&
  receipt.version !== "0.1.0-beta.32" &&
  receipt.version !== "0.1.0-beta.35"
) {
  assert(options.verificationReportPath, "Unified release verification report required");
  await requireReleaseVerification(
    options.verificationReportPath,
    review.candidate,
    commit,
    review.releaseMode,
    action === "publish-for-verification" ? deliveryApproval : undefined,
  );
}
assert(/^\d+\.\d+\.\d+-beta\.\d+$/u.test(receipt.version));
const tag = `v${receipt.version}`;
const repository = "Kubonsang/HoneyBee";
const manifest = JSON.parse(await readBounded(path.join(distribution, "release.json"), 64 * 1024));
assert.equal(
  manifest.packages.application.url,
  `https://github.com/${repository}/releases/download/${tag}/${receipt.application.name}`,
  "Release URL differs from intended GitHub tag",
);
const notes = await readBounded(notesPath, 256 * 1024);
if (action === "publish-for-verification")
  assert(
    notes.toString("utf8").includes("Public delivery verification pending"),
    "Pending public verification must be disclosed",
  );
if (review.releaseMode === "unsigned-beta")
  assert(
    notes.toString("utf8").includes("Windows Authenticode: not signed"),
    "Unsigned beta release notes must disclose Windows Authenticode: not signed",
  );
const assets = [
  "HoneyBeeSetup.exe",
  receipt.application.name,
  "release.json",
  "release.sig.json",
  "SHA256SUMS.txt",
];
const includeWinget =
  receipt.version === beta35DeliveryApproval.version || receipt.version === "0.1.0-beta.36";
if (includeWinget) {
  const pinned =
    receipt.version === beta35DeliveryApproval.version ? beta35DeliveryApproval : deliveryApproval;
  assert(pinned, "Candidate-bound WinGet delivery approval required");
  assert.equal(review.candidate.setupSha256, pinned.setupSha256);
  assert.equal(review.candidate.manifestSha256, pinned.manifestSha256);
  assert.equal(
    (await digestDistributionFile(path.join(distribution, "Kubonsang.HoneyBee.yaml"))).sha256,
    pinned.wingetManifestSha256,
  );
  assets.push("Kubonsang.HoneyBee.yaml");
}
assert.equal(new Set(assets).size, assets.length, "Conflicting release asset names");
const hashes = Object.fromEntries(
  await Promise.all(
    assets.map(async (name) => [name, await digestDistributionFile(path.join(distribution, name))]),
  ),
);
assert.equal(
  await readFile(path.join(distribution, "SHA256SUMS.txt"), "utf8"),
  assets
    .filter((name) => name !== "SHA256SUMS.txt" && name !== "Kubonsang.HoneyBee.yaml")
    .map((name) => `${hashes[name].sha256}  ${name}`)
    .join("\n") + "\n",
  "Checksum list differs from release assets",
);
const gh = async (args) =>
  (
    await promisify(execFile)("gh", args, {
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const releaseInfo = async () =>
  JSON.parse(
    await gh([
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,isDraft,isPrerelease,targetCommitish,url,assets",
    ]),
  );
const base = path.join(distribution, "publication");
await mkdir(base, { recursive: true });
const attempt = await mkdtemp(path.join(base, "attempt-"));
const exactNotes = path.join(attempt, "release-notes.md");
await writeFile(exactNotes, notes, { flag: "wx" });
if (action === "stage") {
  // Resume an interrupted matching draft without replacing any uploaded asset.
  const refs = JSON.parse(await gh(["api", `repos/${repository}/git/matching-refs/tags/${tag}`]));
  assert(!refs.some((ref) => ref.ref === `refs/tags/${tag}`), "Release tag already exists");
  const remoteCommit = JSON.parse(await gh(["api", `repos/${repository}/commits/${commit}`]));
  assert.equal(remoteCommit.sha, commit, "Release commit is not available in repository");
  const releases = JSON.parse(await gh(["api", `repos/${repository}/releases?per_page=100`]));
  assert(Array.isArray(releases));
  const existing = releases.filter((release) => release.tag_name === tag);
  assert(existing.length <= 1, "Ambiguous draft release");
  if (existing.length) {
    assert.equal(existing[0].draft, true, "Existing release is already published");
    assert.equal(existing[0].prerelease, true);
    assert.equal(existing[0].target_commitish, commit, "Existing draft source differs");
    assert.equal(
      existing[0].body.replaceAll("\r\n", "\n").trimEnd(),
      notes.toString("utf8").replaceAll("\r\n", "\n").trimEnd(),
      "Existing draft notes differ",
    );
  } else
    await gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      commit,
      "--draft",
      "--prerelease",
      "--title",
      `HoneyBee ${receipt.version}`,
      "--notes-file",
      exactNotes,
    ]);
  const staged = await releaseInfo();
  const present = staged.assets.map((asset) => asset.name);
  assert.equal(new Set(present).size, present.length, "Duplicate draft assets");
  assert(
    present.every((name) => assets.includes(name)),
    "Unexpected existing draft asset",
  );
  const missing = assets.filter((name) => !present.includes(name));
  if (missing.length)
    await gh([
      "release",
      "upload",
      tag,
      "--repo",
      repository,
      ...missing.map((name) => path.join(distribution, name)),
    ]);
}
const remote = await releaseInfo();
assert.equal(remote.tagName, tag);
assert.equal(remote.isDraft, true, "Only an unpublished draft may be processed");
assert.equal(remote.isPrerelease, true);
assert.equal(remote.targetCommitish, commit, "Draft points to a different source commit");
assert.deepEqual(
  remote.assets.map((asset) => asset.name).sort(),
  [...assets].sort(),
  "Unexpected or incomplete draft assets",
);
const downloaded = path.join(attempt, "download");
await mkdir(downloaded);
await gh([
  "release",
  "download",
  tag,
  "--repo",
  repository,
  "--dir",
  downloaded,
  ...assets.flatMap((name) => ["--pattern", name]),
]);
for (const name of assets) {
  assert.deepEqual(
    await digestDistributionFile(path.join(downloaded, name)),
    hashes[name],
    `Uploaded asset differs: ${name}`,
  );
  assert.deepEqual(
    await digestDistributionFile(path.join(distribution, name)),
    hashes[name],
    `Local artifact changed: ${name}`,
  );
}
const notesOnGitHub = JSON.parse(
  await gh(["release", "view", tag, "--repo", repository, "--json", "body"]),
);
assert.equal(
  notesOnGitHub.body.replaceAll("\r\n", "\n").trimEnd(),
  notes.toString("utf8").replaceAll("\r\n", "\n").trimEnd(),
  "Draft notes differ",
);
if (action === "publish" || action === "publish-for-verification") {
  // Repeat local admission after the network roundtrip; do not rerun qualification.
  const final = await reviewDistribution(options);
  assert.deepEqual(final, review, "Candidate or acceptance changed before publication");
  if (
    ["publish", "publish-for-verification"].includes(action) &&
    receipt.version !== "0.1.0-beta.32" &&
    receipt.version !== "0.1.0-beta.35"
  )
    await requireReleaseVerification(
      options.verificationReportPath,
      final.candidate,
      commit,
      final.releaseMode,
      action === "publish-for-verification" ? await loadDeliveryApproval(options) : undefined,
    );
  await gh([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease",
    "--latest=false",
  ]);
  const published = await releaseInfo();
  assert.equal(published.isDraft, false);
  assert.equal(published.isPrerelease, true);
}
const result = {
  schemaVersion: 1,
  action,
  tag,
  commit,
  url: remote.url,
  hashes,
  releaseMode: review.releaseMode,
  authenticode: review.authenticode,
  releaseCompleted: action === "publish",
  ...(action === "publish-for-verification"
    ? {
        deliveryApproval: review.deliveryApproval,
        remainingPublicChecks: review.remainingPublicChecks,
      }
    : {}),
};
await writeFile(path.join(attempt, "result.json"), JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
