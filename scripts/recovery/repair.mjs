import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { recoverApplicationRepair } from "../update/repair-active.mjs";

const runtime = path.resolve(import.meta.dirname, "../..");
const [rootArgument, name, ...extra] = process.argv.slice(2);
assert(rootArgument && !extra.length);
const installationRoot = path.resolve(rootArgument);
assert.equal(runtime.toLowerCase(), path.join(installationRoot, "recovery/v1").toLowerCase());
const result = await recoverApplicationRepair({ installationRoot, runtime, name });
process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }) + "\n");
