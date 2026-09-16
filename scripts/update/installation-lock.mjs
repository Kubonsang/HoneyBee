import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { plainDirectory } from "./stage-release.mjs";
import { packageTool } from "./prepare-release.mjs";

export const withInstallationUpdateLock = async (installationRoot, work) => {
  const root = path.resolve(installationRoot);
  await plainDirectory(root);
  const update = path.join(root, "update");
  try {
    await mkdir(update);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await plainDirectory(update);
  const child = spawn(packageTool, ["lock", update], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lost = false,
    readyResolve,
    readyReject,
    text = "";
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finished = new Promise((resolve) => {
    child.once("error", (error) => {
      lost = true;
      readyReject(error);
    });
    child.once("close", () => {
      lost = true;
      readyReject(new Error("Update lock unavailable or helper exited"));
      resolve();
    });
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    text += chunk.toString();
    if (text === "LOCKED\n" || text === "LOCKED\r\n") readyResolve();
    else if (text.length > 64) readyReject(new Error("Invalid lock helper response"));
  });
  const startup = setTimeout(() => {
    readyReject(new Error("Update lock helper timed out"));
    child.kill();
  }, 10000);
  const assertHeld = () =>
    assert(
      !lost && child.exitCode === null && child.signalCode === null,
      "Update lock ownership lost",
    );
  try {
    await ready;
    clearTimeout(startup);
    assertHeld();
    const result = await work({ assertHeld });
    assertHeld();
    return result;
  } finally {
    clearTimeout(startup);
    child.stdin.end();
    const shutdown = setTimeout(() => child.kill(), 5000);
    try {
      await finished;
    } finally {
      clearTimeout(shutdown);
    }
  }
};
