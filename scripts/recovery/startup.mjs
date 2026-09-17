import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { recoverAppPointer } from "../update/app-activation.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";
import { checkVersionHealth } from "../update/version-health.mjs";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "../update/recovery-source.mjs";
import { reconnectRecoveryWorkspaces } from "./reconnect-workspaces.mjs";

const runtime = path.resolve(import.meta.dirname, "../..");
const [rootArgument, transactionName, ...extra] = process.argv.slice(2);
assert(
  rootArgument && !extra.length && /^activation-[A-Za-z0-9]+$/u.test(transactionName),
  "Invalid recovery arguments",
);
const root = path.resolve(rootArgument);
assert.equal(
  runtime.toLowerCase(),
  path.join(root, "recovery/v1").toLowerCase(),
  "Recovery runtime outside installation",
);
const attempts = path.join(root, "update/recovery-attempts");
await mkdir(attempts, { recursive: true });
await plainDirectory(attempts);
const evidence = await mkdtemp(path.join(attempts, "startup-"));
const healthChecks = [];
const execute = async () => {
  const directory = path.join(root, "update/activations", transactionName);
  const sourceBytes = await readBounded(path.join(directory, "source.json"));
  const source = JSON.parse(sourceBytes);
  const approved = await resolveRecoverySource({
    installationRoot: root,
    runtime,
    pointer: source,
  });
  const target = JSON.parse(await readBounded(path.join(directory, "target.json")));
  assert.equal(
    source.activeVersion,
    approved.version,
    "Source version is not approved by this bootstrapper",
  );
  assert.equal(
    source.manifestSha256,
    approved.launchSha256,
    "Source release is not approved by this bootstrapper",
  );
  const verifySource = () => verifyRecoverySourceFiles(root, approved);
  const health = async () => {
    await verifySource();
    const result = await checkVersionHealth(
      {
        installationRoot: root,
        version: approved.version,
        launchManifestSha256: approved.launchSha256,
        timeoutMs: 60000,
      },
      {
        authorize: async () => {
          await verifySource();
          return true;
        },
      },
    );
    healthChecks.push(result);
    return result;
  };
  const result = await withApplicationActivity(
    { installationRoot: root, mode: "exclusive", timeoutMs: 30000 },
    async ({ assertHeld }) => {
      await verifySource();
      let reconnectRecord = 0;
      const reconnect = () =>
        reconnectRecoveryWorkspaces({
          root,
          version: approved.version,
          assertHeld,
          record: async (event, value) =>
            writeFile(
              path.join(evidence, `workspace-${reconnectRecord++}.json`),
              JSON.stringify({ event, ...value }),
              { flag: "wx" },
            ),
        });
      const recovered = await recoverAppPointer(
        {
          installationRoot: root,
          transactionDirectory: directory,
          sourcePointerSha256: sha256(sourceBytes),
          targetVersion: target.activeVersion,
          targetManifestSha256: target.manifestSha256,
        },
        {
          admit: async () => {
            assertHeld();
            await verifySource();
            assertHeld();
          },
          health: async ({ version }) => {
            assert.equal(
              version,
              approved.version,
              "Automatic recovery only authorizes the approved source",
            );
            assertHeld();
            let checked = await health();
            const failed = checked.report?.checks.filter((check) => check.status === "fail");
            if (
              !checked.ready &&
              failed?.length > 0 &&
              failed.every((check) => check.code === "workspace.repair-required")
            ) {
              await reconnect();
              checked = await health();
            }
            assertHeld();
            return checked.ready;
          },
        },
      );
      assert.equal(recovered.state, "RolledBack");
      assert.equal((await health()).ready, true, "Recovered source Doctor failed");
      assertHeld();
      assert.deepEqual(await readBounded(path.join(root, "current.json")), sourceBytes);
      return recovered;
    },
  );
  process.stdout.write(JSON.stringify({ schemaVersion: 1, state: result.state }) + "\n");
  return result;
};
try {
  const result = await execute();
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify({ passed: true, result, healthChecks }, null, 2),
  );
} catch (error) {
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify({ passed: false, error: error.message, healthChecks }, null, 2),
  ).catch(() => {});
  throw error;
}
