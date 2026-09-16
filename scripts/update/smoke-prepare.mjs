import { createUpdatePlan } from "./update-plan.mjs";
import { publishPreparedVersion } from "./publish-version.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { packageTool, prepareRelease } from "./prepare-release.mjs";
import { stageRelease } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";

const [payload, ...extra] = process.argv.slice(2);
assert(payload && !extra.length, "Usage: smoke-prepare.mjs ASSEMBLED_VERSION_DIRECTORY");
const metadata = JSON.parse(await readFile(path.join(payload, "installation.json")));
const version = metadata.version;
const base = path.resolve("output/update-prepare-smoke");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "case-"));
const archive = path.join(root, "application.zip");
await promisify(execFile)(packageTool, ["pack", path.resolve(payload), archive], {
  windowsHide: true,
  timeout: 15 * 60 * 1000,
});
const hash = createHash("sha256");
for await (const bytes of createReadStream(archive)) hash.update(bytes);
const size = (await stat(archive)).size;
const source = {
  currentVersion: "0.0.0",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: metadata.componentVersion,
};
const manifest = {
  schemaVersion: 1,
  version,
  channel: "beta",
  mandatory: false,
  minimumSourceVersion: "0.0.0",
  minimumBootstrapperVersion: "1.0.0",
  packages: {
    application: {
      url: `https://github.com/Kubonsang/HoneyBee/releases/download/v${version}/HoneyBee-update-win32-x64.zip`,
      sha256: hash.digest("hex"),
      size,
      format: "zip",
    },
  },
  components: {
    desktop: { version, package: "application" },
    cli: { version, package: "application" },
    storage: {
      componentVersion: metadata.componentVersion,
      package: "application",
      migration: { kind: "none", supportedSourceVersions: [metadata.componentVersion] },
    },
  },
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = sha256(manifestBytes);
const installationRoot = path.join(root, "HoneyBee 설치");
await mkdir(installationRoot);
const pointer = JSON.stringify({ schemaVersion: 1, activeVersion: source.currentVersion });
await writeFile(path.join(installationRoot, "current.json"), pointer);
await writeFile(path.join(installationRoot, "user-state"), "preserve");
const staged = await stageRelease({
  installationRoot,
  manifestBytes,
  manifestSha256,
  source,
  fetchImpl: async () => new globalThis.Response(Readable.toWeb(createReadStream(archive))),
});
const result = await prepareRelease({
  installationRoot,
  stageAttempt: staged.attempt,
  manifestSha256,
  source,
});
const observation = {
  status: "app-only-candidate",
  activationAllowed: false,
  sourceVersion: source.currentVersion,
  targetVersion: version,
  sourceComponentVersion: source.storageComponentVersion,
  sourceEvidenceSha256: sha256("synthetic smoke evidence; no real service probe"),
  sourcePointerSha256: sha256(pointer),
  manifestSha256,
  parentCount: 0,
  remainingGates: ["real-service-qualification", "durable-activation-and-recovery"],
};
const observe = async () => ({ ...observation });
const plan = await createUpdatePlan(
  {
    installationRoot,
    stageAttempt: staged.attempt,
    manifestSha256,
    bootstrapperVersion: source.bootstrapperVersion,
    channel: source.channel,
  },
  { observe },
);
const publication = await publishPreparedVersion(
  { installationRoot, planPath: plan.planPath, planSha256: plan.planSha256 },
  { observe },
);
assert.equal(publication.state, "Published");
assert.equal(await readFile(path.join(installationRoot, "current.json"), "utf8"), pointer);
assert.equal(await readFile(path.join(installationRoot, "user-state"), "utf8"), "preserve");
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify({ ...result, packageBytes: size, publication }, null, 2),
);
process.stdout.write(
  JSON.stringify({ ...result, packageBytes: size, publication }, null, 2) + "\n",
);
