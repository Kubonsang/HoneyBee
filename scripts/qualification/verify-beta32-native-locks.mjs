import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";

const executable = path.resolve(
  "output/two-version-qa/build-5UuH8o/output/installations/0.1.0-beta.32-0h5HGV/HoneyBee/recovery/v1/output/update-tools/honeybee-update-package.exe",
);
const expected = "4b622398202b4b5713849bde179d89149d83d6a916f9a9cbd227e8ea295de6ad";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(await readFile(executable)), expected);
const evidence = await mkdtemp(path.resolve("output/acceptance-completion-20260916/native-locks-"));
const children = [];
const results = [];
const launch = (file, args) => {
  const process = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const item = { process, stdout: "", stderr: "", exited: false, code: null, error: null };
  process.stdout.on("data", (bytes) => {
    item.stdout += bytes;
  });
  process.stderr.on("data", (bytes) => {
    item.stderr += bytes;
  });
  process.stdin.on("error", () => {});
  process.on("error", (error) => {
    item.error = error;
  });
  process.on("close", (code) => {
    item.exited = true;
    item.code = code;
  });
  children.push(item);
  return item;
};
const wait = async (item, condition) => {
  const deadline = Date.now() + 12000;
  while (!condition(item)) {
    if (item.error) throw item.error;
    assert(Date.now() < deadline, `Native child timeout: ${item.stdout} ${item.stderr}`);
    await pause(20);
  }
  assert.equal(item.error, null);
};
const marker = async (item, text) => {
  await wait(item, (state) => state.stdout.includes(text) || state.exited);
  assert(item.stdout.includes(text), item.stderr);
  assert.equal(item.exited, false);
};
const end = async (item) => {
  item.process.stdin.end();
  await wait(item, (state) => state.exited);
};
const rejected = async (args, reason) => {
  const item = launch(executable, args);
  await wait(item, (state) => state.exited);
  assert.equal(item.code, 1, item.stderr);
  if (reason) assert.match(item.stderr, reason);
  return item;
};
const check = async (name, action) => {
  await action();
  results.push({ name, passed: true });
};
try {
  const locks = path.join(evidence, "locks");
  await mkdir(locks);
  await check("exclusive update lock refuses duplicate then releases on EOF", async () => {
    const owner = launch(executable, ["lock", locks]);
    await marker(owner, "LOCKED");
    await rejected(["lock", locks]);
    await end(owner);
    assert.equal(owner.code, 0);
    const retry = launch(executable, ["lock", locks]);
    await marker(retry, "LOCKED");
    await end(retry);
    assert.equal(retry.code, 0);
  });
  await check("process termination releases update lock despite retained lock file", async () => {
    const owner = launch(executable, ["lock", locks]);
    await marker(owner, "LOCKED");
    owner.process.kill();
    await wait(owner, (state) => state.exited);
    const retry = launch(executable, ["lock", locks]);
    await marker(retry, "LOCKED");
    await end(retry);
  });
  await check(
    "drain waits for existing shared work and refuses newcomers and duplicates",
    async () => {
      const shared = launch(executable, ["activity", locks, "shared", "4000"]);
      await marker(shared, "HELD");
      const exclusive = launch(executable, ["activity", locks, "exclusive", "4000"]);
      await marker(exclusive, "DRAINING");
      assert(!exclusive.stdout.includes("HELD"));
      await rejected(["activity", locks, "shared", "100"], /application admission unavailable/u);
      await rejected(["activity", locks, "exclusive", "100"], /application admission unavailable/u);
      await end(shared);
      await marker(exclusive, "HELD");
      await end(exclusive);
    },
  );
  await check("drain timeout preserves active work and reopens admission", async () => {
    const shared = launch(executable, ["activity", locks, "shared", "1000"]);
    await marker(shared, "HELD");
    await rejected(["activity", locks, "exclusive", "100"], /application drain timed out/u);
    assert.equal(shared.exited, false);
    const second = launch(executable, ["activity", locks, "shared", "1000"]);
    await marker(second, "HELD");
    await end(second);
    await end(shared);
  });
  await check("disconnected drain owner preserves active work and reopens admission", async () => {
    const shared = launch(executable, ["activity", locks, "shared", "4000"]);
    await marker(shared, "HELD");
    const exclusive = launch(executable, ["activity", locks, "exclusive", "4000"]);
    await marker(exclusive, "DRAINING");
    await end(exclusive);
    assert.equal(exclusive.code, 1);
    assert.match(exclusive.stderr, /activity owner disconnected/u);
    assert.equal(shared.exited, false);
    const second = launch(executable, ["activity", locks, "shared", "1000"]);
    await marker(second, "HELD");
    await end(second);
    await end(shared);
  });
  const source = path.join(evidence, "source");
  await mkdir(path.join(source, "desktop"), { recursive: true });
  await writeFile(path.join(source, "desktop/app.txt"), "preserved fixture", { flag: "wx" });
  const archive = path.join(evidence, "fixture.zip");
  execFileSync(executable, ["pack", source, archive], { windowsHide: true, timeout: 10000 });
  const digest = hash(await readFile(archive));
  await check("existing extraction directory cannot be overwritten", async () => {
    const destination = path.join(evidence, "existing");
    await mkdir(destination);
    await writeFile(path.join(destination, "sentinel"), "untouched", { flag: "wx" });
    await rejected(["extract", archive, destination, digest]);
    assert.equal(await readFile(path.join(destination, "sentinel"), "utf8"), "untouched");
  });
  await check(
    "locked archive fails without publication and retry succeeds after release",
    async () => {
      const holder = path.join(evidence, "hold.ps1");
      await writeFile(
        holder,
        "$ErrorActionPreference='Stop'\n$f=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)\ntry{[Console]::WriteLine('HELD');[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}\n",
        { flag: "wx" },
      );
      const owner = launch("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        holder,
        archive,
      ]);
      await marker(owner, "HELD");
      const destination = path.join(evidence, "extracted");
      await rejected(["extract", archive, destination, digest]);
      await assert.rejects(readFile(path.join(destination, "desktop/app.txt")), { code: "ENOENT" });
      await end(owner);
      execFileSync(executable, ["extract", archive, destination, digest], {
        windowsHide: true,
        timeout: 10000,
      });
      assert.equal(
        await readFile(path.join(destination, "desktop/app.txt"), "utf8"),
        "preserved fixture",
      );
    },
  );
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed: true,
        executableSha256: expected,
        results,
        evidence,
        scope:
          "Exact candidate native binary, isolated host fixture. Not Desktop UI or real disk-full qualification.",
        acceptancePromoted: false,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({ passed: true, checks: results.length, evidence })}\n`);
} catch (error) {
  await writeFile(
    path.join(evidence, "failed.json"),
    JSON.stringify(
      {
        passed: false,
        error: error.stack,
        results,
        children: children.map(({ stdout, stderr, code }) => ({ stdout, stderr, code })),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  throw error;
} finally {
  for (const child of children) if (!child.exited) child.process.kill();
}
