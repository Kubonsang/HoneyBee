import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { main } from "./release-verify.mjs";
import { readJson, verifyAttachments } from "./release-verification.mjs";
import { summarizeFinalAcceptance } from "./final-acceptance.mjs";

/** Import a reviewed, immutable evidence set in one pass. No installer, service,
 * disk, VM or publication operation is performed by this command. */
export async function runDelta(args) {
  const [config, directory, ...flags] = args.filter((arg) => arg !== "--");
  assert(
    config && directory,
    "Usage: node scripts/qualification/release-delta.mjs <config.json> <output/run> --docker <receipt.json> --windows <receipt.json> --native <receipt.json> --acceptance <acceptance.json>",
  );
  assert(flags.length === 8, "Exactly four evidence inputs required");
  const inputs = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    assert(["--docker", "--windows", "--native", "--acceptance"].includes(flags[i]));
    assert(flags[i + 1] && !inputs.has(flags[i]), "Duplicate or missing evidence input");
    inputs.set(flags[i], flags[i + 1]);
  }
  assert(inputs.size === 4, "Docker, Windows, native and acceptance inputs required");
  const configuration = await readJson(config);
  assert(
    configuration.cleanupManifest === undefined,
    "One-pass evidence import never performs cleanup",
  );
  const acceptance = await readJson(inputs.get("--acceptance"));
  summarizeFinalAcceptance(acceptance);
  assert.deepEqual(acceptance.candidate, configuration.candidate, "Acceptance candidate mismatch");
  for (const lane of ["docker", "windows", "native"]) {
    const file = path.resolve(inputs.get(`--${lane}`));
    const receipt = await readJson(file);
    assert.equal(receipt.lane, lane, `Wrong ${lane} receipt`);
    await verifyAttachments(receipt.attachments, path.dirname(file));
    if (lane === "native")
      assert.deepEqual(receipt.candidate, configuration.candidate, "Native candidate mismatch");
  }
  await main(["plan", config, directory]);
  for (const lane of ["docker", "windows", "native"]) {
    await main(["run", config, directory, "--lane", lane, "--import", inputs.get(`--${lane}`)]);
    process.exitCode = 0; // intermediate missing lanes are expected, not a retry request
  }
  await main(["report", config, directory, "--acceptance", inputs.get("--acceptance")]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runDelta(process.argv.slice(2)).catch((error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
  });
