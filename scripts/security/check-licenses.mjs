import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";

const ALLOWED_PRODUCTION_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
  "Python-2.0",
  "Zlib",
  "(MIT AND Zlib)",
  "(MIT OR Apache-2.0)",
]);

const packageManagerScript = process.env.npm_execpath;
const corepackScript = join(
  dirname(process.execPath),
  "node_modules",
  "corepack",
  "dist",
  "corepack.js",
);
const args = packageManagerScript
  ? [packageManagerScript, "licenses", "list", "--json", "--prod"]
  : [corepackScript, "pnpm", "licenses", "list", "--json", "--prod"];
const result = spawnSync(process.execPath, args, {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  shell: false,
});

if (result.status !== 0) {
  process.stderr.write(
    result.stderr || result.error?.message || "Unable to audit production licenses.\n",
  );
  process.exit(1);
}

const report = JSON.parse(result.stdout);
const declaredLicenses = Object.keys(report).sort();
const rejected = declaredLicenses.filter((license) => !ALLOWED_PRODUCTION_LICENSES.has(license));

if (rejected.length > 0) {
  process.stderr.write(`Production dependency license review required: ${rejected.join(", ")}\n`);
  process.exit(1);
}

const packageCount = Object.values(report).reduce((sum, packages) => sum + packages.length, 0);
process.stdout.write(
  `Production license audit passed (${packageCount} packages; ${declaredLicenses.join(", ")}).\n`,
);
