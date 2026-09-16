import { execFile } from "node:child_process";
import { mkdir, readFile, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(
  repository,
  "output",
  process.argv.includes("--recovery") ? "launcher-recovery" : "launcher",
);
await mkdir(path.join(output, "bin"), { recursive: true });
const recovery = process.argv.includes("--recovery")
  ? JSON.parse(await readFile(path.join(repository, "output/recovery-runtime/candidate.json")))
  : undefined;
if (recovery && !/^[a-f0-9]{64}$/u.test(recovery.manifestSha256))
  throw new Error("Invalid recovery pin");
for (const [relative, linkerFlags] of [
  ["HoneyBeeLauncher.exe", "-H=windowsgui -buildid="],
  ["bin/honeybee.exe", "-buildid="],
]) {
  await run(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      `-ldflags=${linkerFlags}${recovery ? " -X main.recoveryManifestSHA256=" + recovery.manifestSha256 : ""}`,
      "-o",
      path.join(output, relative),
      ".",
    ],
    {
      cwd: path.join(repository, "tools", "honeybee-launcher"),
      env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0", GOWORK: "off" },
      timeout: 120_000,
      windowsHide: true,
    },
  );
}
if (recovery) await cp(recovery.runtime, path.join(output, "recovery/v1"), { recursive: true });
await writeFile(
  path.join(output, "launcher-build.json"),
  JSON.stringify({ schemaVersion: 1, recoveryManifestSha256: recovery?.manifestSha256 ?? null }),
);
process.stdout.write(`${output}\n`);
