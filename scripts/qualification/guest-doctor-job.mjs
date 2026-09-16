import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { createHash } from "node:crypto";
import { checkVersionHealth, runDoctorProcess } from "../update/version-health.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
const bundle = path.resolve(import.meta.dirname, "../..");
const pin = JSON.parse(await readFile(path.join(bundle, "qualification.json")));
assert.equal(os.hostname(), pin.computerName, "Wrong QA computer");
const root = path.join(process.env.LOCALAPPDATA, "HoneyBee");
const hash = async (file) => {
  await plainDirectory(path.dirname(file));
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), "Redirected file");
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
};
assert.equal(await hash(path.join(bundle, "inventory.json")), pin.inventorySha256);
const inventory = JSON.parse(await readFile(path.join(bundle, "inventory.json")));
const verify = async () => {
  for (const [name, digest] of Object.entries(inventory)) {
    assert(
      !name.includes("\\") &&
        !name.includes(":") &&
        name.split("/").every((x) => x && x !== "." && x !== ".."),
    );
    assert.equal(await hash(path.join(root, name)), digest, `Installed payload changed: ${name}`);
  }
  assert.equal(
    await hash(path.join(bundle, "output/update-tools/honeybee-update-package.exe")),
    pin.helperSha256,
  );
};
await verify();
const receiptPath = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/install-receipt.json",
);
const receipt = JSON.parse(await readFile(receiptPath));
assert.equal(receipt.userSid, pin.userSid);
assert.equal(receipt.executableSha256, pin.controlSha256);
const broker = path.join(
  process.env.ProgramData,
  "UnityWorkspaceStorage/broker/unity-workspace-storage-host.exe",
);
assert.equal(await hash(broker), pin.controlSha256);
const files = [
  path.join(root, "current.json"),
  path.join(process.env.LOCALAPPDATA, "HoneyBee/workspace-core/workspace-registry-v2.json"),
  receiptPath,
  path.join(process.env.ProgramData, "UnityWorkspaceStorage/broker-config.json"),
  broker,
];
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        try {
          return [file, await hash(file)];
        } catch (e) {
          if (e.code === "ENOENT") return [file, null];
          throw e;
        }
      }),
    ),
  );
const base = path.join(bundle, "Evidence");
await mkdir(base, { recursive: true });
const evidence = await mkdtemp(path.join(base, "guest-"));
const before = await snapshot();
const health = await checkVersionHealth(
  { installationRoot: root, version: pin.version, launchManifestSha256: pin.launchSha256 },
  {
    authorize: async () => {
      await verify();
      return true;
    },
    run: async (request) => {
      try {
        const result = await runDoctorProcess(request);
        await writeFile(path.join(evidence, "stdout.json"), result.stdout);
        await writeFile(path.join(evidence, "stderr.txt"), result.stderr);
        return result;
      } catch (e) {
        await writeFile(
          path.join(evidence, "process-error.json"),
          JSON.stringify({ message: e.message, stdout: e.stdout, stderr: e.stderr }, null, 2),
        );
        throw e;
      }
    },
  },
);
const after = await snapshot();
const preserved = JSON.stringify(before) === JSON.stringify(after);
await writeFile(
  path.join(evidence, "result.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      computerName: os.hostname(),
      health,
      before,
      after,
      preserved,
    },
    null,
    2,
  ),
);
process.stdout.write(
  JSON.stringify(
    { evidence, ready: health.ready, summary: health.report?.summary, preserved },
    null,
    2,
  ) + "\n",
);
if (!health.ready || !preserved) process.exitCode = 1;
