import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { readBounded } from "../update/prepare-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { activateAuthenticatedUpdate } from "../update/activate-authenticated.mjs";

const [file, digest, ...extra] = process.argv.slice(2);
assert(!extra.length && /^[a-f0-9]{64}$/u.test(digest));
const bytes = await readBounded(file);
assert.equal(sha256(bytes), digest);
const config = JSON.parse(bytes);
assert.equal(config.schemaVersion, 1);
assert.equal(config.qualificationOnly, true);
const root = path.resolve(config.installationRoot);
assert.equal(
  process.execPath.toLowerCase(),
  path.join(root, "recovery/v1/runtime/node.exe").toLowerCase(),
);
assert(/^job-[A-Za-z0-9]+$/u.test(config.job.name));
const requestBytes = await readBounded(
  path.join(root, "update/jobs", config.job.name, "request.json"),
);
assert.equal(sha256(requestBytes), config.job.sha256);
const request = JSON.parse(requestBytes);
const mapping = {
  "app-prepared": "intent",
  "app-selected": "switched",
  "app-validated": "validated",
  "app-health-failure": "validated",
};
const result = await activateAuthenticatedUpdate(
  { installationRoot: root, runtime: path.join(root, "recovery/v1"), request },
  {
    checkpoint: async (state, transactionDirectory) => {
      if (mapping[config.point] !== state) return;
      const output = await open(path.join(path.dirname(file), "reached.json"), "wx");
      try {
        await output.writeFile(
          JSON.stringify({
            schemaVersion: 1,
            configSha256: digest,
            point: config.point,
            processId: process.pid,
            reachedAt: new Date().toISOString(),
            holdDeadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            transactionDirectory,
          }) + "\n",
        );
        await output.sync();
      } finally {
        await output.close();
      }
      if (config.action === "fail") throw Error("QA injected health failure after real validation");
      await delay(5 * 60 * 1000);
      throw Error("QA interruption controller timeout");
    },
  },
);
const output = await open(path.join(path.dirname(file), "worker-result.json"), "wx");
try {
  await output.writeFile(JSON.stringify(result) + "\n");
  await output.sync();
} finally {
  await output.close();
}
