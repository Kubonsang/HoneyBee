import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readInstalledStorage } from "./installed-storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
it("discovers its pinned release without following current.json and rejects corrupted tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-installed-"));
  roots.push(root);
  const release = path.join(root, "versions", "0.1.0-beta.11");
  await mkdir(path.join(release, "tools"), { recursive: true });
  const metadata = JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0-beta.11",
    componentVersion: "test",
    clientSha256: hash("client"),
    controlSha256: hash("host"),
  });
  await writeFile(path.join(release, "installation.json"), metadata);
  await writeFile(
    path.join(release, "launch.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0-beta.11",
      installationSha256: hash(metadata),
    }),
  );
  await writeFile(path.join(release, "tools/unity-workspace-storage.exe"), "client");
  await writeFile(path.join(release, "tools/honeybee-workspace-storage-host.exe"), "host");
  await writeFile(path.join(root, "current.json"), "an unrelated activation is in progress");
  const selected = await readInstalledStorage(release);
  expect(selected?.installationRoot).toBe(root);
  expect(selected?.managed?.clientCommand).toBe(
    path.join(release, "tools/unity-workspace-storage.exe"),
  );
  expect(await readFile(path.join(root, "current.json"), "utf8")).toBe(
    "an unrelated activation is in progress",
  );
  await writeFile(path.join(release, "tools/honeybee-workspace-storage-host.exe"), "damaged");
  await expect(readInstalledStorage(release)).rejects.toMatchObject({
    code: "installation.invalid",
  });
  await expect(readInstalledStorage(path.join(root, "portable"))).resolves.toBeUndefined();
  await expect(readInstalledStorage(path.join(root, "versions", "missing"))).rejects.toMatchObject({
    code: "installation.invalid",
  });
});
