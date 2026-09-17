import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { withApplicationActivity } from "../update/application-activity.mjs";
const repository = path.resolve(import.meta.dirname, "../..");
const candidate = JSON.parse(
  await readFile(process.argv[2] ?? path.join(repository, "output/two-version-qa/candidate.json")),
);
const root = path.resolve(candidate.installation);
assert(
  root.startsWith(path.join(repository, "output/two-version-qa") + path.sep),
  "QA installation required",
);
const pointer = await readFile(path.join(root, "current.json"));
const version = JSON.parse(pointer).activeVersion;
const release = path.join(root, "versions", version);
assert.equal(
  JSON.parse(await readFile(path.join(release, "installation.json"))).activity.protocol,
  1,
);
const base = path.join(repository, "output/desktop-lifecycle-smoke");
await mkdir(base, { recursive: true });
const evidence = await mkdtemp(path.join(base, "case-"));
const runs = [];
for (const entry of ["desktop", "launcher"]) {
  const profile = path.join(evidence, entry);
  await mkdir(profile);
  const resultPath = path.join(profile, "result.json");
  const executable =
    entry === "desktop"
      ? path.join(release, "desktop/HoneyBee.exe")
      : path.join(root, "HoneyBeeLauncher.exe");
  const env = {
    ...process.env,
    TEMP: evidence,
    TMP: evidence,
    HONEYBEE_DESKTOP_SMOKE: "desktop-smoke-v2",
    HONEYBEE_DESKTOP_LIFECYCLE_SMOKE: "lifecycle-v1",
    HONEYBEE_DESKTOP_SMOKE_RESULT: resultPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [
      "--user-data-dir=" + profile,
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-software-rasterizer",
      "--no-sandbox",
      "--enable-logging=stderr",
    ],
    {
      cwd: profile,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let diagnostics = "";
  const collect = (b) => {
    diagnostics = (diagnostics + b.toString()).slice(-65536);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    const deadline = Date.now() + 60000;
    let stage;
    while (Date.now() < deadline) {
      try {
        stage = JSON.parse(await readFile(resultPath, "utf8")).stage;
      } catch (e) {
        if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
      }
      if (stage === "lifecycle-cancelled") break;
      assert(
        (child.exitCode === null && child.signalCode === null) ||
          (entry === "launcher" && child.exitCode === 0),
        `Desktop exited (${child.exitCode}/${child.signalCode}) at ${stage}: ${diagnostics}`,
      );
      await setTimeout(100);
    }
    assert.equal(stage, "lifecycle-cancelled", diagnostics);
    let entered = false;
    await assert.rejects(
      withApplicationActivity(
        { installationRoot: root, mode: "exclusive", timeoutMs: 100 },
        async () => {
          entered = true;
        },
      ),
    );
    assert.equal(entered, false, "Cancelled Desktop lost its activity lease");
    await writeFile(resultPath + ".continue", "continue", { flag: "wx" });
    let timer;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error("Desktop quit deadline exceeded")),
          15000,
        );
      }),
    ]).finally(() => globalThis.clearTimeout(timer));
    assert.equal(result[0], 0, diagnostics);
    const quitDeadline = Date.now() + 15000;
    while (Date.now() < quitDeadline) {
      if (JSON.parse(await readFile(resultPath)).stage === "lifecycle-passed") break;
      await setTimeout(100);
    }
    assert.equal(JSON.parse(await readFile(resultPath)).stage, "lifecycle-passed");
    await withApplicationActivity(
      { installationRoot: root, mode: "exclusive", timeoutMs: 5000 },
      async ({ assertHeld }) => assertHeld(),
    );
    assert.deepEqual(await readFile(path.join(root, "current.json")), pointer);
    runs.push({
      entry,
      passed: true,
      cancellationRetainedLease: true,
      quitReleasedLease: true,
      pointerPreserved: true,
    });
  } finally {
    // The GUI launcher detaches. Let only this isolated smoke instance finish,
    // including when the controller fails before acknowledging cancellation.
    await writeFile(resultPath + ".continue", "continue", { flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeFile(path.join(profile, "process.log"), diagnostics);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => {});
  }
}
await writeFile(
  path.join(evidence, "qualification.json"),
  JSON.stringify({ passed: true, runs, installation: root }, null, 2),
);
process.stdout.write(JSON.stringify({ evidence, passed: true, runs }, null, 2) + "\n");
