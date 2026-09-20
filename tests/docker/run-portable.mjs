import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { readdirSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { auditCoverage, jsonObjects } from "../../scripts/qualification/test-coverage.mjs";
import { inventory } from "../../scripts/qualification/release-verification.mjs";

const results = [];
const logs = new Map();
const windows = process.platform === "win32";
mkdirSync("output/verification-suite", { recursive: true });
if (windows) {
  mkdirSync("output/node-runtime", { recursive: true });
  copyFileSync(process.execPath, "output/node-runtime/node.exe");
}
function stage(name, command, args, options = {}) {
  console.log(`\n>>> ${name}`);
  const started = Date.now();
  if (windows && command === "corepack") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& corepack ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`,
    ];
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 ** 2,
    windowsHide: true,
    ...options,
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  process.stdout.write(output);
  logs.set(name, output);
  const record = {
    name,
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    elapsedMs: Date.now() - started,
  };
  results.push(record);
  console.log(JSON.stringify(record));
}
function files(root, suffix) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = `${root}/${entry.name}`;
    return entry.isDirectory() ? files(name, suffix) : name.endsWith(suffix) ? [name] : [];
  });
}
// No blanket platform exclusions. Native-only cases use their existing explicit skips.
stage("source-secret-scan", "node", ["scripts/security/check-no-secrets.mjs", "--all"]);
stage("licenses", "corepack", ["pnpm", "licenses:check"]);
stage("source-format", "corepack", [
  "pnpm",
  "exec",
  "prettier",
  "--check",
  "apps",
  "packages",
  "scripts",
  "tests",
  "docs",
]);
stage("lint", "corepack", ["pnpm", "lint"]);
stage("typecheck", "corepack", ["pnpm", "typecheck"]);
stage("build", "corepack", ["pnpm", "build"]);
stage("desktop-test-modules", "corepack", [
  "pnpm",
  "exec",
  "tsc",
  "-p",
  "apps/desktop/tsconfig.main.build.json",
]);
stage("dependency-boundaries", "corepack", ["pnpm", "deps:check"]);
stage("vitest", "corepack", [
  "pnpm",
  "exec",
  "vitest",
  "run",
  "--maxWorkers=2",
  "--reporter=default",
  "--reporter=json",
  "--outputFile=output/verification-suite/vitest.json",
]);
stage("update-package-tool", "node", ["scripts/update/build-package-tool.mjs"]);
const nodeTests = files("scripts", ".test.mjs").filter(
  (file) => !file.startsWith("scripts/security/") && !file.startsWith("scripts/dogfood/"),
);
console.log(JSON.stringify({ nodeTestFiles: nodeTests }));
stage("node-contracts", "node", [
  "--test",
  "--test-reporter=./tests/docker/node-reporter.mjs",
  `--test-concurrency=${windows ? 1 : 2}`,
  ...nodeTests,
]);
stage("python-analysis", windows ? "python" : "python3", [
  "-m",
  "unittest",
  "discover",
  "-s",
  "scripts/benchmarks/vhdx",
  "-p",
  "test_*.py",
  "-v",
]);
const windowsOnlyPowerShell = new Map([
  [
    "scripts/qualification/inspect-integrated-guest.test.ps1",
    "Uses WindowsIdentity/WindowsPrincipal and the Windows C: drive, even with CIM stubbed.",
  ],
]);
for (const file of files("scripts", ".test.ps1")) {
  const reason = !windows && windowsOnlyPowerShell.get(file);
  if (reason) console.log(JSON.stringify({ windowsOnlyPowerShell: file, reason }));
  else stage(`powershell:${file}`, "pwsh", ["-NoProfile", "-NonInteractive", "-File", file]);
}
for (const cwd of [
  "external/storage",
  "tools/workspace-storage-host",
  "tools/honeybee-launcher",
  "tools/honeybee-update-package",
]) {
  stage(`${cwd}:platform-inventory`, "go", ["list", "-json", "./..."], { cwd });
  stage(
    `${cwd}:race-tests`,
    "go",
    ["test", "-race", "-count=1", "-timeout=180s", "-json", "./..."],
    { cwd },
  );
  stage(`${cwd}:vet`, "go", ["vet", "./..."], { cwd });
}
stage(
  "upstream-removal-fixture-race-repeat",
  "go",
  [
    "test",
    "-race",
    "-count=50",
    "-timeout=180s",
    "-run",
    "^TestRetainedRemovalAbortAndExpiryReleaseReservation$",
    "./workspace",
  ],
  { cwd: "external/storage" },
);
let coverage;
try {
  const source = await inventory(process.cwd());
  if (source.unclassified.length)
    throw Error(`Unclassified tests: ${JSON.stringify(source.unclassified)}`);
  coverage = auditCoverage({
    vitest: JSON.parse(readFileSync("output/verification-suite/vitest.json", "utf8")),
    nodeLog: logs.get("node-contracts"),
    goLogs: [...logs.entries()]
      .filter(([name]) => name.endsWith(":race-tests"))
      .map(([, log]) => log),
    platform: process.platform,
    root: path.resolve("."),
    ignoredGoTests: [...logs.entries()]
      .filter(([name]) => name.endsWith(":platform-inventory"))
      .flatMap(([, log]) => jsonObjects(log))
      .flatMap((pkg) =>
        (pkg.IgnoredGoFiles ?? [])
          .filter((file) => file.endsWith("_windows_test.go"))
          .flatMap((file) =>
            [
              ...readFileSync(path.join(pkg.Dir, file), "utf8").matchAll(
                /^func (Test\w+)\(t \*testing\.T\)/gmu,
              ),
            ].map((match) => ({ package: pkg.ImportPath, name: match[1] })),
          ),
      ),
  });
  for (const [file, reason] of windowsOnlyPowerShell) {
    const id = `powershell:${file}`;
    if (windows && results.find((stage) => stage.name === id)?.ok) coverage.passed.push(id);
    else if (!windows) coverage.deferred.push({ id, owner: "windows", reason });
  }
  if (coverage.unexpectedSkips)
    throw Error(`Unexpected test outcomes: ${JSON.stringify(coverage.unexpected)}`);
  results.push({ name: "coverage-audit", ok: true });
} catch (error) {
  results.push({ name: "coverage-audit", ok: false, error: error.message });
}
console.log(
  JSON.stringify({
    portableVerification: true,
    nativeWindowsQualification: false,
    results,
    coverage,
  }),
);
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
