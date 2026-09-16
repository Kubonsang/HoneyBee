import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { packageTool } from "./prepare-release.mjs";
import { runDoctorProcess } from "./version-health.mjs";
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
};
const until = async (action) => {
  for (let i = 0; i < 100; i++) {
    const value = await action();
    if (value) return value;
    await setTimeout(50);
  }
  assert.fail("process containment deadline exceeded");
};
for (const mode of [
  "normal",
  "timeout",
  "helper-killed",
  "parent-killed",
  "pipe-holder",
  "overflow",
])
  test(`Doctor job removes descendants after ${mode}`, { timeout: 15000 }, async (t) => {
    const base = path.resolve("output/doctor-job-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "case-")),
      cli = path.join(cwd, "probe.cjs"),
      pids = path.join(cwd, "pids.json");
    await writeFile(
      cli,
      `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',${JSON.stringify(mode === "pipe-holder" ? "process.stdout.write('holding pipe');process.send('ready');setInterval(()=>{},1000)" : "setInterval(()=>{},1000)")}],{windowsHide:true,stdio:${mode === "pipe-holder" ? "['ignore','inherit','inherit','ipc']" : "'ignore'"}});
    fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
    ${mode === "overflow" ? "process.stdout.write('x'.repeat(2*1024*1024));" : ""}
    ${mode === "pipe-holder" ? "child.on('message',()=>process.exit(0));" : mode === "normal" ? "child.unref();" : "setInterval(()=>{},1000);"}`,
    );
    let processHandle;
    let completion;
    if (mode === "helper-killed") {
      processHandle = spawn(packageTool, ["doctor", process.execPath, cli, cwd, "10000"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      completion = once(processHandle, "exit");
    } else if (mode === "parent-killed") {
      const module = pathToFileURL(path.resolve("scripts/update/version-health.mjs")).href;
      processHandle = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {runDoctorProcess} from ${JSON.stringify(module)};await runDoctorProcess(JSON.parse(process.argv[1]));`,
          JSON.stringify({ node: process.execPath, cli, cwd, timeoutMs: 10000 }),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      completion = once(processHandle, "exit");
    } else {
      completion = runDoctorProcess({
        node: process.execPath,
        cli,
        cwd,
        timeoutMs: mode === "timeout" ? 1500 : 5000,
      }).then(
        (output) => ({ ok: true, output }),
        (error) => ({ error }),
      );
    }
    t.after(() => processHandle?.kill());
    const ids = await until(async () => {
      try {
        return JSON.parse(await readFile(pids, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
        throw error;
      }
    });
    // Exact fixture PIDs only, as a failure-cleanup fallback; assert exit before cleanup.
    t.after(() => {
      for (const pid of ids) if (!gone(pid)) process.kill(pid);
    });
    if (processHandle) processHandle.kill();
    const result = await completion;
    if (mode === "normal") assert.equal(result.ok, true);
    if (mode === "timeout" || mode === "overflow") assert(result.error);
    if (mode === "pipe-holder" && result.ok) assert.equal(result.output.stdout, "holding pipe");
    await until(() => ids.every(gone));
  });
