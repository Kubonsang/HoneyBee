import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  admitRelease,
  compareVersions,
  parseReleaseManifest,
  sha256,
  validateDownloadUrl,
} from "./release-manifest.mjs";
import { downloadResponse, stageRelease } from "./stage-release.mjs";
import { requireDiskSpace } from "./disk-space.mjs";

const payload = Buffer.from("fixture archive bytes; never executed or extracted");
const source = {
  currentVersion: "0.1.0-beta.11",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: "0.0.0+source.hb12",
};
const manifest = () => ({
  schemaVersion: 1,
  version: "0.1.0-beta.12",
  channel: "beta",
  mandatory: false,
  minimumSourceVersion: "0.1.0-beta.11",
  minimumBootstrapperVersion: "1.0.0",
  packages: {
    application: {
      url: "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.12/HoneyBee-update.zip",
      sha256: sha256(payload),
      size: payload.length,
      format: "zip",
    },
  },
  components: {
    desktop: { version: "0.1.0-beta.12", package: "application" },
    cli: { version: "0.1.0-beta.12", package: "application" },
    storage: {
      componentVersion: source.storageComponentVersion,
      package: "application",
      migration: { kind: "none", supportedSourceVersions: [source.storageComponentVersion] },
    },
  },
});
const encode = (value) => {
  const manifestBytes = Buffer.from(JSON.stringify(value));
  return { manifestBytes, manifestSha256: sha256(manifestBytes) };
};
const response = (bytes = payload, headers = {}) =>
  new globalThis.Response(bytes, { status: 200, headers });
const fixture = async () => {
  const base = path.resolve("output/update-tests");
  await mkdir(base, { recursive: true });
  const installationRoot = await mkdtemp(path.join(base, "case-"));
  await writeFile(path.join(installationRoot, "current.json"), "known-good-pointer");
  await mkdir(path.join(installationRoot, "workspace-core"));
  await writeFile(path.join(installationRoot, "workspace-core/registry.json"), "user-state");
  return { installationRoot, source, ...encode(manifest()), fetchImpl: async () => response() };
};
const preserved = async (root) => {
  assert.equal(await readFile(path.join(root, "current.json"), "utf8"), "known-good-pointer");
  assert.equal(
    await readFile(path.join(root, "workspace-core/registry.json"), "utf8"),
    "user-state",
  );
};

test("capacity uses user-available bytes and rejects insufficient or unknown capacity", async () => {
  await requireDiskSpace("fixture", 8192, async () => ({ bavail: 2n, bsize: 4096n }));
  await assert.rejects(
    requireDiskSpace("fixture", 8193, async () => ({ bavail: 2n, bsize: 4096n })),
    { code: "ENOSPC" },
  );
  await assert.rejects(
    requireDiskSpace("fixture", 1, async () => ({ bavail: -1n, bsize: 4096n })),
    { code: "ENOSPC" },
  );
  await assert.rejects(
    requireDiskSpace("fixture", 1, async () => ({ bavail: 1n, bsize: 0n })),
    /unavailable/,
  );
});

test("insufficient capacity refuses package download before creating update state", async () => {
  const options = await fixture();
  let fetched = false;
  await assert.rejects(
    stageRelease({
      ...options,
      checkSpace: async (directory, required) => {
        assert.equal(directory, options.installationRoot);
        assert.equal(required, payload.length + 64 * 1024 * 1024);
        await requireDiskSpace(directory, required, async () => ({ bavail: 0n, bsize: 4096n }));
      },
      fetchImpl: async () => {
        fetched = true;
        return response();
      },
    }),
    { code: "ENOSPC" },
  );
  assert.equal(fetched, false);
  assert.deepEqual((await readdir(options.installationRoot)).sort(), [
    "current.json",
    "workspace-core",
  ]);
  await preserved(options.installationRoot);
});

test("download progress ends Verified only after complete hash validation", async () => {
  const options = await fixture();
  const progress = [];
  await stageRelease({
    ...options,
    onProgress: (event) => {
      assert(Object.isFrozen(event));
      progress.push(event);
    },
  });
  assert.deepEqual(progress[0], { state: "Downloading", received: 0, total: payload.length });
  assert.deepEqual(progress.at(-1), {
    state: "Verified",
    received: payload.length,
    total: payload.length,
  });
  const bad = [];
  await assert.rejects(
    stageRelease({
      ...options,
      fetchImpl: async () => response(Buffer.alloc(payload.length)),
      onProgress: (event) => bad.push(event),
    }),
  );
  assert(!bad.some((event) => event.state === "Verified"));
  await preserved(options.installationRoot);
});

test("UI cancellation from initial progress cannot fetch or activate the package", async () => {
  const options = await fixture();
  const controller = new globalThis.AbortController();
  let fetched = false;
  await assert.rejects(
    stageRelease({
      ...options,
      signal: controller.signal,
      onProgress: () => controller.abort(),
      fetchImpl: async () => {
        fetched = true;
        return response();
      },
    }),
  );
  assert.equal(fetched, false);
  await preserved(options.installationRoot);
});

test("release grammar and beta ordering are explicit", () => {
  assert(compareVersions("0.1.0-beta.9", "0.1.0-beta.11") < 0);
  assert(compareVersions("0.1.0", "0.1.0-beta.12") > 0);
  assert(compareVersions("0.2.0-beta.1", "0.1.0") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  for (const version of ["../x", "1.0.0-rc.1", "01.0.0", "9007199254740993.0.0"])
    assert.throws(() => compareVersions(version, "1.0.0"));
});
test("strict schema, exact manifest digest and source eligibility", () => {
  const valid = encode(manifest());
  assert.deepEqual(parseReleaseManifest(valid.manifestBytes, valid.manifestSha256), manifest());
  assert.throws(() => parseReleaseManifest(valid.manifestBytes, "0".repeat(64)));
  assert.throws(() => parseReleaseManifest(Buffer.alloc(65537), "0".repeat(64)));
  for (const mutate of [
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.signature = "unverified";
    },
    (m) => {
      m.packages.application.size = -1;
    },
    (m) => {
      m.packages.application.size = 5 * 1024 ** 3;
    },
    (m) => {
      m.components.cli.version = "0.1.0-beta.10";
    },
    (m) => {
      m.components.storage.migration.supportedSourceVersions = ["other.hb11"];
    },
    (m) => {
      m.channel = "stable";
    },
    (m) => {
      m.minimumSourceVersion = m.version;
    },
  ]) {
    const value = manifest();
    mutate(value);
    const encoded = encode(value);
    assert.throws(() => parseReleaseManifest(encoded.manifestBytes, encoded.manifestSha256));
  }
  admitRelease(manifest(), source);
  for (const overrides of [
    { currentVersion: "0.1.0-beta.10" },
    { currentVersion: "0.1.0-beta.12" },
    { bootstrapperVersion: "0.9.0" },
    { channel: "stable" },
    { storageComponentVersion: "old.hb11" },
  ])
    assert.throws(() => admitRelease(manifest(), { ...source, ...overrides }));
});
test("package URL policy rejects credentials, other repositories and local destinations", () => {
  for (const url of [
    "http://github.com/Kubonsang/HoneyBee/releases/download/v/a.zip",
    "https://user:secret@github.com/Kubonsang/HoneyBee/releases/download/v/a.zip",
    "https://github.com/other/HoneyBee/releases/download/v/a.zip",
    "https://127.0.0.1/a.zip",
    "https://github.com:444/Kubonsang/HoneyBee/releases/download/v/a.zip",
    "https://release-assets.githubusercontent.com/a.zip",
  ])
    assert.throws(() => validateDownloadUrl(url));
});
test("redirect destination is checked before issuing a request", async () => {
  const calls = [];
  await assert.rejects(
    downloadResponse(
      manifest().packages.application.url,
      new globalThis.AbortController().signal,
      async (url) => {
        calls.push(url);
        return new globalThis.Response(null, {
          status: 302,
          headers: { location: "http://localhost/private" },
        });
      },
    ),
  );
  assert.equal(calls.length, 1);
});
test("GitHub asset redirect succeeds and redirect loops are bounded", async () => {
  let calls = 0;
  const url = manifest().packages.application.url;
  const redirect = () =>
    new globalThis.Response(null, {
      status: 302,
      headers: { location: "https://release-assets.githubusercontent.com/asset?token=redacted" },
    });
  const result = await downloadResponse(url, new globalThis.AbortController().signal, async () =>
    ++calls === 1 ? redirect() : response(),
  );
  assert.equal(await result.text(), payload.toString());
  calls = 0;
  await assert.rejects(
    downloadResponse(url, new globalThis.AbortController().signal, async () => {
      calls++;
      return redirect();
    }),
  );
  assert.equal(calls, 6);
});
test("verified staging writes durable sequence and preserves installed/user state", async () => {
  const options = await fixture();
  const result = await stageRelease(options);
  assert.equal(result.state, "Verified");
  assert.equal(result.activationAllowed, false);
  assert.deepEqual(await readFile(path.join(result.attempt, "application.zip")), payload);
  assert.deepEqual(
    (await readdir(result.attempt)).sort(),
    [
      "001-Downloading.json",
      "002-Downloaded.json",
      "003-Verified.json",
      "application.zip",
      "release.json",
    ].sort(),
  );
  await preserved(options.installationRoot);
});
for (const [name, fetchImpl] of [
  ["hash mismatch", async () => response(Buffer.alloc(payload.length))],
  ["truncated body", async () => response(payload.subarray(0, 5))],
  ["oversized body", async () => response(Buffer.concat([payload, payload]))],
  ["wrong Content-Length", async () => response(payload, { "content-length": "1" })],
  ["encoded response", async () => response(payload, { "content-encoding": "gzip" })],
  ["HTTP failure", async () => new globalThis.Response("not found", { status: 404 })],
  [
    "network interruption",
    async () => ({
      status: 200,
      headers: new globalThis.Headers(),
      body: {
        async *[Symbol.asyncIterator]() {
          yield payload.subarray(0, 3);
          throw new Error("connection lost");
        },
      },
    }),
  ],
]) {
  test(`${name} retains evidence without activating; retry uses a new attempt`, async () => {
    const options = await fixture();
    await assert.rejects(stageRelease({ ...options, fetchImpl }));
    const [name] = await readdir(path.join(options.installationRoot, "update"));
    const records = await readdir(path.join(options.installationRoot, "update", name));
    assert(records.some((name) => name.endsWith("-Failed.json")));
    assert(!records.some((name) => name.endsWith("-Verified.json")));
    await stageRelease(options);
    assert.equal((await readdir(path.join(options.installationRoot, "update"))).length, 2);
    await preserved(options.installationRoot);
  });
}
test("cancel before admission writes nothing; cancel during stream retains partial evidence", async () => {
  const options = await fixture();
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(stageRelease({ ...options, signal: controller.signal }));
  await assert.rejects(readdir(path.join(options.installationRoot, "update")), { code: "ENOENT" });
  const during = new globalThis.AbortController();
  await assert.rejects(
    stageRelease({
      ...options,
      signal: during.signal,
      fetchImpl: async () => ({
        status: 200,
        headers: new globalThis.Headers(),
        body: {
          async *[Symbol.asyncIterator]() {
            yield payload.subarray(0, 3);
            during.abort();
            yield payload.subarray(3);
          },
        },
      }),
    }),
  );
  await preserved(options.installationRoot);
});
test("invalid manifest/source is rejected before any staging writes or network access", async () => {
  const options = await fixture();
  await assert.rejects(
    stageRelease({
      ...options,
      source: { ...source, currentVersion: "0.0.0" },
      fetchImpl: () => assert.fail("Unexpected network"),
    }),
  );
  await assert.rejects(readdir(path.join(options.installationRoot, "update")), { code: "ENOENT" });
});
test("concurrent attempts are isolated", async () => {
  const options = await fixture();
  const results = await Promise.all([stageRelease(options), stageRelease(options)]);
  assert.notEqual(results[0].attempt, results[1].attempt);
  await preserved(options.installationRoot);
});
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { symlink } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

test("redirected update directory is refused", async () => {
  const options = await fixture();
  const outside = await fixture();
  await symlink(
    outside.installationRoot,
    path.join(options.installationRoot, "update"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(stageRelease(options), /Redirected staging directory/u);
  assert.deepEqual((await readdir(outside.installationRoot)).sort(), [
    "current.json",
    "workspace-core",
  ]);
  await preserved(options.installationRoot);
});
test(
  "process termination leaves a non-authoritative partial attempt and retry succeeds",
  { timeout: 15000 },
  async (t) => {
    const options = await fixture();
    const script = `
    import { stageRelease } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/update/stage-release.mjs")).href)};
    const input = JSON.parse(process.argv[1]);
    input.manifestBytes = Buffer.from(input.manifestBytes);
    input.fetchImpl = async () => ({status:200, headers:new globalThis.Headers(), body:{async *[Symbol.asyncIterator]() {
      yield Buffer.from("partial");
      process.stdout.write("partial-written");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }}});
    await stageRelease(input);
  `;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({ ...options, manifestBytes: [...options.manifestBytes] }),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(([code]) => {
        throw new Error(`Child exited before interruption: ${code}: ${stderr}`);
      }),
    ]);
    child.kill();
    await exited;
    const [name] = await readdir(path.join(options.installationRoot, "update"));
    const files = await readdir(path.join(options.installationRoot, "update", name));
    assert(files.includes("001-Downloading.json"));
    assert(files.includes("application.zip.partial"));
    assert(!files.some((entry) => entry.endsWith("-Verified.json")));
    await preserved(options.installationRoot);
    await stageRelease(options);
    assert.equal((await readdir(path.join(options.installationRoot, "update"))).length, 2);
  },
);

test("developer entry point rejects a bad manifest pin before network or target writes", async () => {
  const options = await fixture();
  const manifestPath = path.join(options.installationRoot, "input-release.json");
  await writeFile(manifestPath, options.manifestBytes);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/update/stage.mjs",
      options.installationRoot,
      manifestPath,
      "0".repeat(64),
      source.currentVersion,
      source.bootstrapperVersion,
      source.channel,
      source.storageComponentVersion,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Manifest SHA-256 mismatch/u);
  await assert.rejects(readdir(path.join(options.installationRoot, "update")), { code: "ENOENT" });
  await preserved(options.installationRoot);
});
