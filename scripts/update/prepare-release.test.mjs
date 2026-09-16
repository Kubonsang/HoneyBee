import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareRelease } from "./prepare-release.mjs";
import { fixture, preserved, version } from "./prepare-fixture.mjs";
import { sha256 } from "./release-manifest.mjs";

for (const mode of ["valid", "missing-marker", "wrong-helper", "unsupported-protocol"])
  test(`activity package verification: ${mode}`, async () => {
    const options = await fixture((files) => {
      files["runtime/honeybee-lifecycle.exe"] = "helper";
      files["desktop/activity-client.json"] = JSON.stringify({ schemaVersion: 1, protocol: 1 });
      if (mode !== "missing-marker")
        files["cli/activity-client.json"] = files["desktop/activity-client.json"];
      const installation = JSON.parse(files["installation.json"]);
      installation.activity = {
        protocol: mode === "unsupported-protocol" ? 2 : 1,
        helperSha256: sha256(mode === "wrong-helper" ? "different" : "helper"),
      };
      files["installation.json"] = JSON.stringify(installation);
      const launch = JSON.parse(files["launch.json"]);
      launch.installationSha256 = sha256(files["installation.json"]);
      files["launch.json"] = JSON.stringify(launch);
    });
    if (mode === "valid") assert.equal((await prepareRelease(options)).state, "Prepared");
    else await assert.rejects(prepareRelease(options));
    await preserved(options);
  });
test("native package -> stage -> prepare verifies all files without activation", async () => {
  const options = await fixture();
  const result = await prepareRelease(options);
  assert.equal(result.state, "Prepared");
  assert.equal(result.activationAllowed, false);
  assert.equal(
    await readFile(path.join(result.directory, "desktop/HoneyBee.exe"), "utf8"),
    "desktop",
  );
  await preserved(options);
  assert.notEqual((await prepareRelease(options)).directory, result.directory);
});
for (const [name, alter] of [
  [
    "wrong release identity",
    (files) => {
      const launch = JSON.parse(files["launch.json"]);
      launch.version = "9.0.0";
      files["launch.json"] = JSON.stringify(launch);
    },
  ],
  [
    "wrong executable digest",
    (files) => {
      files["desktop/HoneyBee.exe"] = "wrong";
    },
  ],
  [
    "missing runtime",
    (files) => {
      delete files["runtime/node.exe"];
    },
  ],
  [
    "mismatched control companion",
    (files) => {
      files["cli/dist/honeybee-workspace-storage-host.exe"] = "wrong";
    },
  ],
])
  test(name, async () => {
    const options = await fixture(alter);
    await assert.rejects(prepareRelease(options));
    await preserved(options);
  });
for (const phase of ["before-extract", "after-extract", "before-prepared"])
  test(`interruption at ${phase} keeps evidence and retries independently`, async () => {
    const options = await fixture();
    await assert.rejects(
      prepareRelease({
        ...options,
        checkpoint: async (point) => {
          if (point === phase) throw new Error("injected interruption");
        },
      }),
    );
    const attempts = (await readdir(path.join(options.installationRoot, "update"))).filter((name) =>
      name.startsWith("prepare-"),
    );
    assert(
      (await readdir(path.join(options.installationRoot, "update", attempts[0]))).includes(
        "002-Failed.json",
      ),
    );
    await prepareRelease(options);
    await preserved(options);
  });
test("tampered staged archive is rehashed despite Verified marker", async () => {
  const options = await fixture();
  const archive = path.join(options.stageAttempt, "application.zip");
  const bytes = await readFile(archive);
  bytes[0] ^= 1;
  await writeFile(archive, bytes);
  await assert.rejects(prepareRelease(options));
  await preserved(options);
});
test("post-extraction tampering cannot produce Prepared", async () => {
  const options = await fixture();
  await assert.rejects(
    prepareRelease({
      ...options,
      checkpoint: async (point) => {
        if (point === "after-extract") {
          const attempt = (await readdir(path.join(options.installationRoot, "update"))).find(
            (name) => name.startsWith("prepare-"),
          );
          await writeFile(
            path.join(
              options.installationRoot,
              "update",
              attempt,
              "versions",
              version,
              "desktop/HoneyBee.exe",
            ),
            "changed",
          );
        }
      },
    }),
  );
  await preserved(options);
});
