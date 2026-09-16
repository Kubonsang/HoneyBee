import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import process from "node:process";
import { stageRelease } from "./stage-release.mjs";

// Developer-only entry point. Version/storage facts must eventually come from trusted local admission.
try {
  const [
    installationRoot,
    manifestPath,
    manifestSha256,
    currentVersion,
    bootstrapperVersion,
    channel,
    storageComponentVersion,
    ...extra
  ] = process.argv.slice(2);
  assert(
    storageComponentVersion && extra.length === 0,
    "Usage: stage.mjs INSTALL_ROOT MANIFEST SHA256 CURRENT_VERSION BOOTSTRAPPER_VERSION CHANNEL STORAGE_VERSION",
  );
  const file = await open(manifestPath, "r");
  let manifestBytes;
  try {
    assert((await file.stat()).size <= 64 * 1024, "Manifest exceeds 64 KiB");
    const buffer = new Uint8Array(64 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    assert(bytesRead <= 64 * 1024, "Manifest exceeds 64 KiB");
    manifestBytes = Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
  const result = await stageRelease({
    installationRoot,
    manifestBytes,
    manifestSha256,
    source: { currentVersion, bootstrapperVersion, channel, storageComponentVersion },
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
