import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
const repository = path.resolve(import.meta.dirname, "../..");
const output = path.join(repository, "output/update-tools");
await mkdir(output, { recursive: true });
await promisify(execFile)(
  "go",
  [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-o",
    path.join(output, "honeybee-update-package.exe"),
    ".",
  ],
  {
    cwd: path.join(repository, "tools/honeybee-update-package"),
    env: { ...process.env, CGO_ENABLED: "0", GOWORK: "off" },
    windowsHide: true,
    timeout: 120000,
  },
);
