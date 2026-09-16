import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import runtimePin from "./runtime-pin.json" with { type: "json" };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { version, archiveSha256, source } = runtimePin;
const output = path.join(repository, "output", "node-runtime");
await mkdir(output, { recursive: true });
const archive = path.join(output, "runtime.zip");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let bytes = await readFile(archive).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (bytes === undefined) {
  const response = await globalThis.fetch(source, {
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  assert(
    response.ok && new globalThis.URL(response.url).hostname === "nodejs.org",
    "Unexpected runtime download response",
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 64 * 1024 * 1024, "Node runtime archive exceeded size limit");
    chunks.push(chunk);
  }
  bytes = Buffer.concat(chunks);
  assert.equal(hash(bytes), archiveSha256, "Node runtime checksum mismatch");
  await writeFile(archive, bytes, { flag: "wx" });
}
assert.equal(hash(bytes), archiveSha256, "Cached Node runtime checksum mismatch");
const staging = await mkdtemp(path.join(output, "extract-"));
await promisify(execFile)(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath $env:HONEYBEE_RUNTIME_ARCHIVE -DestinationPath $env:HONEYBEE_RUNTIME_STAGING",
  ],
  {
    env: { ...process.env, HONEYBEE_RUNTIME_ARCHIVE: archive, HONEYBEE_RUNTIME_STAGING: staging },
    windowsHide: true,
    timeout: 120_000,
  },
);
for (const name of ["node.exe", "LICENSE"])
  await copyFile(path.join(staging, `node-v${version}-win-x64`, name), path.join(output, name));
const result = await promisify(execFile)(path.join(output, "node.exe"), ["--version"], {
  windowsHide: true,
});
assert.equal(result.stdout.trim(), `v${version}`);
assert.equal(hash(await readFile(path.join(output, "node.exe"))), runtimePin.nodeSha256);
assert.equal(hash(await readFile(path.join(output, "LICENSE"))), runtimePin.licenseSha256);
await writeFile(
  path.join(output, "runtime-source.json"),
  JSON.stringify(
    {
      version,
      source,
      archiveSha256,
      nodeSha256: hash(await readFile(path.join(output, "node.exe"))),
      licenseSha256: hash(await readFile(path.join(output, "LICENSE"))),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${output}\n`);
