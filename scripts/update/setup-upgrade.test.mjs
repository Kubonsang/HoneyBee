import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createEmbeddedReleaseTransport, authorizeMatchingSetup } from "./setup-upgrade.mjs";
import { signReleaseManifest } from "./release-authentication.mjs";
import { stageAuthenticatedRelease } from "./authenticated-release.mjs";
import { sha256 } from "./release-manifest.mjs";

test("later matching Setup repairs only the approved app while retaining original infrastructure", async () => {
  const parent = path.resolve("output/setup-media-tests");
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(path.join(parent, "repair-")),
    root = path.join(base, "installed"),
    source = path.join(base, "setup");
  const version = "0.1.0-beta.12",
    files = {
      "launch.json": "launch",
      "installation.json": JSON.stringify({ activity: { protocol: 1 } }),
      "desktop/app": "original app",
    };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, "versions", version, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const pointer = JSON.stringify({
    schemaVersion: 1,
    generation: 2,
    activeVersion: version,
    manifestSha256: sha256("launch"),
  });
  await writeFile(path.join(root, "current.json"), pointer);
  await cp(root, source, { recursive: true });
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, ".setup-pending"));
  const inventory = {};
  for (const name of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"]) {
    await writeFile(path.join(root, name), name);
    inventory[name] = sha256(name);
  }
  await writeFile(
    path.join(root, ".setup-pending/prepared.json"),
    JSON.stringify({ schemaVersion: 1, inventory }),
  );
  const runtime = path.join(root, "recovery/v1");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "manifest.json"), "runtime manifest");
  await writeFile(
    path.join(runtime, "approved-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      launchSha256: sha256("launch"),
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
      ),
    }),
  );
  const run = async (_exe, args) => {
    assert.deepEqual(args, ["--verify-recovery-runtime"]);
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        recoveryManifestSha256: sha256("runtime manifest"),
      }),
    };
  };
  const options = { installationRoot: root, sourceInstallation: source };
  assert.equal((await authorizeMatchingSetup(options, { run })).runtime, runtime);
  await writeFile(path.join(root, "versions", version, "desktop/app"), "damaged app");
  await assert.rejects(authorizeMatchingSetup(options, { run }), /payload changed/);
  await authorizeMatchingSetup({ ...options, verifyActive: false }, { run });
  await writeFile(path.join(root, "bin/honeybee.exe"), "damaged shim");
  await assert.rejects(
    authorizeMatchingSetup({ ...options, verifyActive: false }, { run }),
    /bootstrapper or shim/,
  );
  assert.equal(await readFile(path.join(root, "current.json"), "utf8"), pointer);
});

test("embedded Setup media uses release signature and streaming package verification", async () => {
  const parent = path.resolve("output/setup-media-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const media = path.join(root, "media"),
    installationRoot = path.join(root, "installed");
  await mkdir(media);
  await mkdir(installationRoot);
  const pointer = Buffer.from("preserved active pointer");
  await writeFile(path.join(installationRoot, "current.json"), pointer);
  const keys = generateKeyPairSync("ed25519"),
    payload = Buffer.from("fixture archive; never executed");
  const manifest = {
    schemaVersion: 1,
    version: "0.1.0-beta.13",
    channel: "beta",
    mandatory: false,
    minimumSourceVersion: "0.1.0-beta.12",
    minimumBootstrapperVersion: "1.0.0",
    packages: {
      application: {
        url: "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.13/application.zip",
        sha256: sha256(payload),
        size: payload.length,
        format: "zip",
      },
    },
    components: {
      desktop: { version: "0.1.0-beta.13", package: "application" },
      cli: { version: "0.1.0-beta.13", package: "application" },
      storage: {
        componentVersion: "test.hb13",
        package: "application",
        migration: { kind: "none", supportedSourceVersions: ["test.hb13"] },
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(media, "release.json"), bytes);
  await writeFile(
    path.join(media, "release.sig.json"),
    signReleaseManifest(bytes, keys.privateKey),
  );
  await writeFile(path.join(media, "application.zip"), payload);
  await assert.rejects(
    createEmbeddedReleaseTransport(media, [generateKeyPairSync("ed25519").publicKey]),
  );
  const transport = await createEmbeddedReleaseTransport(media, [keys.publicKey]);
  await assert.rejects(transport.fetchImpl("https://example.com/unrelated"));
  const options = {
    installationRoot,
    ...transport,
    trustedPublicKeys: [keys.publicKey],
    source: {
      currentVersion: "0.1.0-beta.12",
      bootstrapperVersion: "1.0.0",
      channel: "beta",
      storageComponentVersion: "test.hb13",
    },
    signal: globalThis.AbortSignal.timeout(30000),
  };
  const staged = await stageAuthenticatedRelease(options);
  assert.equal(staged.state, "Verified");
  assert.deepEqual(await readFile(path.join(staged.attempt, "application.zip")), payload);
  await writeFile(path.join(media, "application.zip"), Buffer.alloc(payload.length));
  await assert.rejects(stageAuthenticatedRelease(options), /staging failed/);
  assert.deepEqual(await readFile(path.join(installationRoot, "current.json")), pointer);
});
