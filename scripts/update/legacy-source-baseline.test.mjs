import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./release-manifest.mjs";
import { combinedUpdateIdentity } from "./combined-update.mjs";
import { checkLegacySourceBaseline } from "./legacy-source-baseline.mjs";

const fixture = async () => {
  const parent = path.resolve("output/legacy-source-baseline-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const source = {
    schemaVersion: 1,
    generation: 1,
    activeVersion: "0.1.0-beta.35",
    manifestSha256: "272b131a2d3deaffedee07f94e904f9ec1d822d868b8eb2494b60576f947b2cb",
  };
  const sourceBytes = Buffer.from(JSON.stringify(source));
  const target = {
    ...source,
    generation: 2,
    activeVersion: "0.1.0-beta.38",
    manifestSha256: sha256("target launch"),
  };
  const identity = {
    manifestSha256: sha256("target release"),
    sourcePointerSha256: sha256(sourceBytes),
    serviceTransactionSha256: sha256("transaction"),
  };
  const context = {
    schemaVersion: 1,
    identity,
    identitySha256: combinedUpdateIdentity(identity),
    sourcePointer: sourceBytes.toString("base64"),
    targetPointer: Buffer.from(JSON.stringify(target)).toString("base64"),
    launcherSha256: sha256("launcher"),
    nativeCoordinator: "target",
    sourceRecovery: "legacy-hb12-detached",
    sourceObservationSha256: sha256("original source evidence"),
  };
  await writeFile(path.join(root, "current.json"), sourceBytes);
  await mkdir(path.join(root, "recovery/v1"), { recursive: true });
  await writeFile(
    path.join(root, "recovery/v1/update-trust.json"),
    JSON.stringify({ schemaVersion: 1, bootstrapperVersion: "1.0.0", channel: "beta" }),
  );
  const observation = {
    schemaVersion: 1,
    status: "migration-required",
    reason: "legacy-detached-recovery-required",
    activationAllowed: false,
    sourceRecovery: "legacy-hb12-detached",
    sourceVersion: source.activeVersion,
    targetVersion: target.activeVersion,
    manifestSha256: identity.manifestSha256,
    sourceComponentVersion: "0.0.0+cfa606fd4143.hb12",
    sourcePointerSha256: identity.sourcePointerSha256,
    sourceEvidenceSha256: context.sourceObservationSha256,
    parentCount: 1,
  };
  return { root, sourceBytes, context, observation, options: { installationRoot: root, context } };
};

test("restored legacy baseline remains explicitly unready for Workspace use and activation", async () => {
  const f = await fixture();
  let authorizations = 0,
    observations = 0;
  const result = await checkLegacySourceBaseline(f.options, {
    authorize: async (binding) => {
      authorizations++;
      assert(Object.isFrozen(binding));
      assert.equal(binding.sourceObservationSha256, f.context.sourceObservationSha256);
      assert.equal(binding.sourcePointerSha256, sha256(f.sourceBytes));
      return true;
    },
    observe: async (request) => {
      observations++;
      assert.deepEqual(request, {
        installationRoot: f.root,
        manifestPath: path.join(f.root, "update/recovery-sources/0.1.0-beta.38/release.json"),
        manifestSha256: f.context.identity.manifestSha256,
        bootstrapperVersion: "1.0.0",
        channel: "beta",
        sourceRecovery: "legacy-hb12-detached",
      });
      return f.observation;
    },
  });
  assert.equal(authorizations, 2);
  assert.equal(observations, 1);
  assert.equal(result.baselineRestored, true);
  assert.equal(result.ready, false);
  assert.equal(result.readyForWorkspaceOperations, false);
  assert.equal(result.activationAllowed, false);
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.sourceBytes);
});

test("refused authorization cannot execute the source observation", async () => {
  const f = await fixture();
  const result = await checkLegacySourceBaseline(f.options, {
    authorize: async () => false,
    observe: async () => {
      throw new Error("must not observe unauthenticated code");
    },
  });
  assert.equal(result.baselineRestored, false);
  assert.match(result.failure.message, /authorization refused/u);
});

for (const field of [
  "status",
  "reason",
  "activationAllowed",
  "sourceRecovery",
  "sourceVersion",
  "targetVersion",
  "manifestSha256",
  "sourceComponentVersion",
  "sourcePointerSha256",
  "sourceEvidenceSha256",
  "parentCount",
])
  test(`refuses changed or missing ${field} in the restored observation`, async () => {
    const f = await fixture();
    Reflect.deleteProperty(f.observation, field);
    const result = await checkLegacySourceBaseline(f.options, {
      authorize: async () => true,
      observe: async () => f.observation,
    });
    assert.equal(result.baselineRestored, false);
    assert.equal(result.ready, false);
    assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.sourceBytes);
  });

test("source pointer drift and authentication drift cannot pass baseline restoration", async () => {
  for (const phase of ["pointer-before", "pointer-during", "authentication-after"]) {
    const f = await fixture();
    if (phase === "pointer-before") await writeFile(path.join(f.root, "current.json"), "changed");
    let authorizations = 0;
    const result = await checkLegacySourceBaseline(f.options, {
      authorize: async () => ++authorizations === 1 || phase !== "authentication-after",
      observe: async () => {
        if (phase === "pointer-during")
          await writeFile(path.join(f.root, "current.json"), "changed");
        return f.observation;
      },
    });
    assert.equal(result.baselineRestored, false);
  }
});

test("snapshots caller context before authorization awaits", async () => {
  const f = await fixture();
  const result = await checkLegacySourceBaseline(f.options, {
    authorize: async () => {
      f.context.sourceRecovery = "force";
      f.context.sourceObservationSha256 = sha256("changed");
      return true;
    },
    observe: async (request) => {
      assert.equal(request.sourceRecovery, "legacy-hb12-detached");
      return f.observation;
    },
  });
  assert.equal(result.baselineRestored, true);
});

test("requires explicit source mode, target coordinator and authorization", async () => {
  const f = await fixture();
  await assert.rejects(checkLegacySourceBaseline(f.options), /authorization required/u);
  for (const field of ["sourceRecovery", "nativeCoordinator", "sourceObservationSha256"]) {
    const context = globalThis.structuredClone(f.context);
    Reflect.deleteProperty(context, field);
    await assert.rejects(
      checkLegacySourceBaseline({ ...f.options, context }, { authorize: async () => true }),
    );
  }
});

test("cannot relabel another source package as the reproduced legacy baseline", async () => {
  for (const changed of [
    { activeVersion: "0.1.0-beta.36" },
    { manifestSha256: sha256("another source package") },
  ]) {
    const f = await fixture();
    const source = {
      ...JSON.parse(Buffer.from(f.context.sourcePointer, "base64")),
      ...changed,
    };
    const bytes = Buffer.from(JSON.stringify(source));
    f.context.sourcePointer = bytes.toString("base64");
    f.context.identity.sourcePointerSha256 = sha256(bytes);
    f.context.identitySha256 = combinedUpdateIdentity(f.context.identity);
    await writeFile(path.join(f.root, "current.json"), bytes);
    let called = false;
    await assert.rejects(
      checkLegacySourceBaseline(f.options, {
        authorize: async () => {
          called = true;
          return true;
        },
      }),
    );
    assert.equal(called, false);
  }
});
