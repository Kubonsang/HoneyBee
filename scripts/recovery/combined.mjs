import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readBounded } from "../update/prepare-release.mjs";
import { plainDirectory } from "../update/stage-release.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";
import { validateCombinedApplicationContext } from "../update/combined-application.mjs";
import { runCombinedApplicationTransaction } from "../update/installed-combined-update.mjs";

const runtime = path.resolve(import.meta.dirname, "../..");
const [rootArgument, identity, ...extra] = process.argv.slice(2);
assert(
  rootArgument && /^[a-f0-9]{64}$/u.test(identity) && extra.length === 0,
  "Invalid combined recovery arguments",
);
const root = path.resolve(rootArgument);
assert.equal(
  runtime.toLowerCase(),
  path.join(root, "recovery/v1").toLowerCase(),
  "Combined recovery runtime is outside installation",
);
const context = JSON.parse(
  await readBounded(path.join(root, "update/combined-contexts", identity + ".json")),
);
validateCombinedApplicationContext(context);
assert.equal(context.identitySha256, identity);
const parent = path.join(root, "update/recovery-attempts");
await mkdir(parent, { recursive: true });
await plainDirectory(parent);
const evidence = await mkdtemp(path.join(parent, "combined-"));
try {
  const result = await withApplicationActivity(
    { installationRoot: root, mode: "exclusive", timeoutMs: 30000 },
    async (activity) =>
      runCombinedApplicationTransaction({ root, runtime, context, activity, recover: true }),
  );
  assert(["Committed", "RolledBack"].includes(result.state));
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify({ schemaVersion: 1, ok: true, result }, null, 2) + "\n",
    { flag: "wx" },
  );
} catch (error) {
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify({ schemaVersion: 1, ok: false, error: error.message }, null, 2) + "\n",
    { flag: "wx" },
  );
  throw error;
}
