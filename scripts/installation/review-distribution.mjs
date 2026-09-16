import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { readBounded } from "../update/prepare-release.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { summarizeFinalAcceptance } from "../qualification/final-acceptance.mjs";
import { digestDistributionFile } from "./prepare-distribution.mjs";
import { renderWingetManifest } from "./winget-manifest.mjs";
import { distributionPolicy, distributionReadiness } from "./distribution-policy.mjs";

/** Offline handoff review, not a test runner or publishing authorization.
 * Trust anchors come from the caller, never from the distribution receipt. */
export async function reviewDistribution(options) {
  const directory = path.resolve(options.directory);
  await plainDirectory(directory);
  const read = (name, limit = 64 * 1024) => readBounded(path.join(directory, name), limit);
  const authenticated = authenticateReleaseManifest(
    await read("release.json"),
    await read("release.sig.json", 4096),
    options.trustedPublicKeys,
  );
  const receipt = JSON.parse(await read("distribution.json"));
  const policy = distributionPolicy(options, authenticated.manifest);
  assert.equal(receipt.releaseMode ?? "signed", policy.releaseMode);
  assert.equal(receipt.authenticode ?? "signed", policy.authenticode);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.version, authenticated.manifest.version);
  assert.equal(receipt.channel, authenticated.manifest.channel);
  assert.equal(receipt.manifestSha256, authenticated.manifestSha256);
  assert.equal(receipt.signerKeyId, authenticated.signerKeyId);
  assert.equal(receipt.publisherThumbprint?.toUpperCase() ?? null, policy.publisherThumbprint);
  const expected = authenticated.manifest.packages.application;
  const name = decodeURIComponent(new URL(expected.url).pathname.split("/").at(-1));
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/u.test(name));
  const application = await digestDistributionFile(path.join(directory, name));
  assert.deepEqual(application, { sha256: expected.sha256, size: expected.size });
  assert.deepEqual(receipt.application, { name, ...application });
  const setupPath = path.join(directory, "HoneyBeeSetup.exe");
  const setup = await digestDistributionFile(setupPath);
  assert.deepEqual(setup, receipt.setup, "Setup changed after distribution assembly");
  const result = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-authenticode.ps1"),
      "-Artifact",
      setupPath,
      "-ReleaseMode",
      policy.releaseMode,
      ...(policy.publisherThumbprint ? ["-PublisherThumbprint", policy.publisherThumbprint] : []),
      "-ExpectedVersion",
      authenticated.manifest.version,
    ],
    { windowsHide: true, timeout: 120000 },
  );
  const signature = JSON.parse(result.stdout.trim());
  assert.equal(signature.valid, true);
  assert.equal(signature.authenticode, policy.authenticode);
  assert.deepEqual(await digestDistributionFile(setupPath), setup, "Setup changed during review");
  assert.equal(
    (await read("Kubonsang.HoneyBee.yaml")).toString("utf8"),
    renderWingetManifest({
      version: receipt.version,
      setupUrl: new URL("HoneyBeeSetup.exe", expected.url).href,
      setupSha256: setup.sha256,
    }),
    "WinGet manifest differs from reviewed candidate",
  );
  const acceptance = summarizeFinalAcceptance(
    JSON.parse(await readBounded(options.acceptancePath, 1024 * 1024)),
  );
  const candidate = { setupSha256: setup.sha256, manifestSha256: authenticated.manifestSha256 };
  assert.deepEqual(acceptance.candidate, candidate, "Acceptance belongs to a different candidate");
  return {
    schemaVersion: 1,
    candidate,
    artifactsVerified: true,
    acceptanceReady: acceptance.ready,
    counts: acceptance.counts,
    ...policy,
    ...distributionReadiness(policy, acceptance),
    evidenceVerifiedByTool: false,
    publicationAllowed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert(
    process.argv[2] && process.argv[3],
    "Usage: review-distribution.mjs <config.json> <new-report.json>",
  );
  const report = await reviewDistribution(
    JSON.parse(await readBounded(process.argv[2], 64 * 1024)),
  );
  await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
