import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { recoveryResumeDecision } from "./setup-recovery-resume.mjs";
import { sha256 } from "./release-manifest.mjs";
import {
  listRecoveryJobs,
  prepareSetupRecovery,
  readSetupMetadata,
  setupRecoveryRoute,
} from "./setup-recovery.mjs";

const source = () => ({
  installation: "managed",
  identityVerified: true,
  currentVersion: "0.1.0-beta.39",
  bootstrapperVersion: "1.0.0",
  channel: "beta",
  storageComponentVersion: "hb17",
});
test("resume never repeats an uncertain native execution, including after a new Starting record", () => {
  const events = [{ state: "Running" }, { state: "Unresolved" }, { state: "Starting" }];
  assert.equal(recoveryResumeDecision(events, undefined, "0.1.0-beta.40"), "Unresolved");
  assert.equal(
    recoveryResumeDecision([{ state: "Starting" }], undefined, "0.1.0-beta.40"),
    "launch",
  );
  assert.equal(
    recoveryResumeDecision(
      [...events, { state: "Verifying", exitCode: 0 }],
      undefined,
      "0.1.0-beta.40",
    ),
    "verify",
  );
  assert.equal(
    recoveryResumeDecision(
      [...events, { state: "Verifying", exitCode: 1 }],
      undefined,
      "0.1.0-beta.40",
    ),
    "Unresolved",
  );
  for (const [outcome, expected] of [
    [{ state: "RolledBack" }, "RolledBack"],
    [{ state: "UpdateCancelled" }, "Cancelled"],
    [{ state: "Updated", version: "0.1.0-beta.40" }, "verify"],
    [{ state: "Updated", version: "0.1.0-beta.41" }, "Unresolved"],
  ])
    assert.equal(recoveryResumeDecision(events, outcome, "0.1.0-beta.40"), expected);
});
const manifest = () => ({
  version: "0.1.0-beta.40",
  minimumSourceVersion: "0.1.0-beta.35",
  minimumBootstrapperVersion: "1.0.0",
  channel: "beta",
  components: {
    storage: {
      componentVersion: "hb17",
      migration: {
        kind: "service-replacement",
        supportedSourceVersions: ["hb17", "0.0.0+cfa606fd4143.hb12"],
      },
    },
  },
});
test("matching storage uses the application updater; matching-version repair uses Setup", () => {
  assert.equal(
    setupRecoveryRoute({ source: source(), manifest: manifest(), intent: "update" }),
    "application-update",
  );
  assert.equal(
    setupRecoveryRoute({
      source: source(),
      manifest: { ...manifest(), version: source().currentVersion },
      intent: "repair",
    }),
    "setup-repair",
  );
});
test("legacy routing requires exact beta35 source and independently verified legacy identity", () => {
  const legacy = {
    ...source(),
    currentVersion: "0.1.0-beta.35",
    storageComponentVersion: "0.0.0+cfa606fd4143.hb12",
    legacyVerified: true,
  };
  assert.equal(
    setupRecoveryRoute({ source: legacy, manifest: manifest(), intent: "update" }),
    "setup-transition",
  );
  for (const changed of [
    { ...legacy, legacyVerified: false },
    { ...legacy, currentVersion: "0.1.0-beta.36" },
    { ...legacy, identityVerified: false },
  ])
    assert.throws(() =>
      setupRecoveryRoute({ source: changed, manifest: manifest(), intent: "update" }),
    );
});
test("portable, owner mismatch, downgrade, channel changes and unknown storage are refused", () => {
  for (const changed of [
    { ...source(), installation: "portable" },
    { ...source(), identityVerified: false },
    { ...source(), currentVersion: "0.1.0-beta.41" },
    { ...source(), channel: "stable" },
    { ...source(), storageComponentVersion: "hb-unknown" },
  ])
    assert.throws(() =>
      setupRecoveryRoute({ source: changed, manifest: manifest(), intent: "update" }),
    );
  assert.throws(() =>
    setupRecoveryRoute({ source: source(), manifest: manifest(), intent: "repair" }),
  );
});
test("metadata refuses oversized and incomplete responses", async () => {
  const url = "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.40/setup.json";
  const signal = new globalThis.AbortController().signal;
  await assert.rejects(
    readSetupMetadata(url, 2, signal, async () => new globalThis.Response("too large")),
  );
  await assert.rejects(
    readSetupMetadata(
      url,
      100,
      signal,
      async () => new globalThis.Response("short", { headers: { "content-length": "10" } }),
    ),
  );
});

async function fixture() {
  const parent = path.resolve("output/setup-recovery-unit-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const pointer = JSON.stringify({ activeVersion: source().currentVersion });
  await writeFile(path.join(root, "current.json"), pointer);
  const bytes = Buffer.from("test Setup bytes; never executed");
  const offer = {
    route: "setup-repair",
    metadata: { "release.json": Buffer.from("test metadata") },
    release: { manifest: { version: source().currentVersion } },
    setup: {
      descriptor: {
        setup: {
          url: "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.39/HoneyBeeSetup.exe",
          size: bytes.length,
          sha256: sha256(bytes),
        },
      },
    },
  };
  return { root, pointer, bytes, offer };
}
test("verified preparation preserves the installation and refuses a second unresolved job", async () => {
  const f = await fixture(),
    signal = new globalThis.AbortController().signal;
  const input = {
    ...f,
    source: source(),
    intent: "repair",
    signal,
    fetchImpl: async () => new globalThis.Response(f.bytes),
  };
  const job = await prepareSetupRecovery(input);
  assert.equal((await listRecoveryJobs(f.root))[0].events.at(-1).state, "Review");
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
  assert.equal(
    sha256(await readFile(path.join(job.directory, "HoneyBeeSetup.exe"))),
    f.offer.setup.descriptor.setup.sha256,
  );
  await assert.rejects(prepareSetupRecovery(input), /existing recovery/u);
});
test("a corrupted download retains evidence and never becomes executable review state", async () => {
  const f = await fixture();
  await assert.rejects(
    prepareSetupRecovery({
      ...f,
      source: source(),
      intent: "repair",
      signal: new globalThis.AbortController().signal,
      fetchImpl: async () => new globalThis.Response(Buffer.alloc(f.bytes.length)),
    }),
    /digest/u,
  );
  assert.equal((await listRecoveryJobs(f.root))[0].events.at(-1).state, "Failed");
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});
test("cancelled preparation preserves the old installation and records cancellation", async () => {
  const f = await fixture(),
    abort = new globalThis.AbortController();
  await assert.rejects(
    prepareSetupRecovery({
      ...f,
      source: source(),
      intent: "repair",
      signal: abort.signal,
      fetchImpl: async () => {
        abort.abort();
        return new globalThis.Response(f.bytes);
      },
    }),
  );
  assert.equal((await listRecoveryJobs(f.root))[0].events.at(-1).state, "Cancelled");
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), f.pointer);
});
