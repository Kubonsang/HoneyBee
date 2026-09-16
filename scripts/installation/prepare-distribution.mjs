import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { readBounded } from "../update/prepare-release.mjs";
import { authenticateReleaseManifest } from "../update/release-authentication.mjs";
import { renderWingetManifest } from "./winget-manifest.mjs";
import { createFinalAcceptance } from "../qualification/final-acceptance.mjs";
import { distributionPolicy } from "./distribution-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const digestDistributionFile = async (file) => {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), "Ordinary distribution artifact required");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  assert.equal(size, info.size, "Artifact changed while hashing");
  return { sha256: hash.digest("hex"), size };
};

/** Offline assembly only. Requires signed artifacts unless unsigned-beta is explicit; never signs, publishes,
 * invents production trust, or treats a successful assembly as qualification. */
export async function prepareDistribution(options) {
  const manifestBytes = await readBounded(options.manifestPath, 64 * 1024);
  const signatureBytes = await readBounded(options.signaturePath, 4096);
  const authenticated = authenticateReleaseManifest(
    manifestBytes,
    signatureBytes,
    options.trustedPublicKeys,
  );
  const expected = authenticated.manifest.packages.application;
  const policy = distributionPolicy(options, authenticated.manifest);
  const originalSetup = await digestDistributionFile(options.setupPath);
  assert.deepEqual(
    await digestDistributionFile(options.applicationPath),
    { sha256: expected.sha256, size: expected.size },
    "Signed package differs from local application ZIP",
  );
  await mkdir(options.outputRoot, { recursive: true });
  const directory = await mkdtemp(path.join(path.resolve(options.outputRoot), "distribution-"));
  const setup = path.join(directory, "HoneyBeeSetup.exe");
  await copyFile(options.setupPath, setup);
  assert.deepEqual(
    await digestDistributionFile(setup),
    originalSetup,
    "Setup changed while copying",
  );
  const result = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(here, "verify-authenticode.ps1"),
      "-Artifact",
      setup,
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
  assert.deepEqual(
    await digestDistributionFile(setup),
    originalSetup,
    "Setup changed during verification",
  );
  const applicationName = decodeURIComponent(new URL(expected.url).pathname.split("/").at(-1));
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/u.test(applicationName),
    "Ordinary application asset name required",
  );
  const application = path.join(directory, applicationName);
  await copyFile(options.applicationPath, application);
  assert.deepEqual(await digestDistributionFile(application), {
    sha256: expected.sha256,
    size: expected.size,
  });
  await writeFile(path.join(directory, "release.json"), manifestBytes, { flag: "wx" });
  await writeFile(path.join(directory, "release.sig.json"), signatureBytes, { flag: "wx" });
  const receipt = {
    schemaVersion: 1,
    version: authenticated.manifest.version,
    channel: authenticated.manifest.channel,
    ...policy,
    manifestSha256: authenticated.manifestSha256,
    signerKeyId: authenticated.signerKeyId,
    publisherThumbprint: signature.publisherThumbprint,
    setup: await digestDistributionFile(setup),
    application: { name: applicationName, ...(await digestDistributionFile(application)) },
    qualification: "pending",
    publicationAllowed: false,
  };
  await writeFile(
    path.join(directory, "acceptance-input.json"),
    JSON.stringify(
      createFinalAcceptance({
        setupSha256: receipt.setup.sha256,
        manifestSha256: receipt.manifestSha256,
      }),
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(directory, "distribution.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  const setupUrl = new URL("HoneyBeeSetup.exe", expected.url).href;
  await writeFile(
    path.join(directory, "Kubonsang.HoneyBee.yaml"),
    renderWingetManifest({ version: receipt.version, setupUrl, setupSha256: receipt.setup.sha256 }),
    { flag: "wx" },
  );
  const sums = ["HoneyBeeSetup.exe", applicationName, "release.json", "release.sig.json"];
  await writeFile(
    path.join(directory, "SHA256SUMS.txt"),
    (
      await Promise.all(
        sums.map(
          async (name) =>
            `${(await digestDistributionFile(path.join(directory, name))).sha256}  ${name}`,
        ),
      )
    ).join("\n") + "\n",
    { flag: "wx" },
  );
  return { directory, ...receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = JSON.parse(await readBounded(process.argv[2], 64 * 1024));
  process.stdout.write(JSON.stringify(await prepareDistribution(config), null, 2) + "\n");
}
