import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readInstalledStorage } from "./installed-storage.js";
import { WorkspaceCoreError } from "./workspace-types.js";
import { assertCombinedAdmission } from "./combined-admission.js";
import { assertApplicationRepairAdmission } from "./repair-admission.js";

export interface InstalledActivityLease {
  readonly signal: AbortSignal;
  assertHeld(): void;
  release(): Promise<void>;
}

/** Portable and pre-protocol installations remain legacy, never proof of quiescence. */
export const acquireInstalledActivity = async (
  releaseRoot: string,
  validationId?: string,
): Promise<InstalledActivityLease | undefined> => {
  const storage = await readInstalledStorage(releaseRoot);
  if (storage === undefined) return undefined;
  const metadataBytes = await readFile(path.join(releaseRoot, "installation.json"));
  const launch = JSON.parse(await readFile(path.join(releaseRoot, "launch.json"), "utf8")) as {
    installationSha256?: unknown;
  };
  if (createHash("sha256").update(metadataBytes).digest("hex") !== launch.installationSha256)
    throw new WorkspaceCoreError(
      "installation.activity-invalid",
      "Installation metadata changed during activity admission.",
    );
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
    activity?: { protocol?: unknown; helperSha256?: unknown };
  };
  if (metadata.activity === undefined) return undefined;
  if (
    metadata.activity?.protocol !== 1 ||
    typeof metadata.activity.helperSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(metadata.activity.helperSha256)
  )
    throw new WorkspaceCoreError(
      "installation.activity-invalid",
      "Unsupported application activity metadata.",
    );
  const helper = path.join(releaseRoot, "runtime/honeybee-lifecycle.exe");
  const info = await lstat(helper);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 32 * 1024 * 1024 ||
    (await realpath(helper)).toLowerCase() !== path.resolve(helper).toLowerCase() ||
    createHash("sha256")
      .update(await readFile(helper))
      .digest("hex") !== metadata.activity.helperSha256
  )
    throw new WorkspaceCoreError(
      "installation.activity-invalid",
      "Application activity helper failed verification.",
    );
  const directory = path.join(path.resolve(releaseRoot, "../.."), "update");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw new WorkspaceCoreError(
      "installation.activity-invalid",
      "Redirected application activity directory.",
    );
  const child = spawn(helper, ["activity", directory, "shared", "10000"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  let released = false,
    output = "";
  const unavailable = () =>
    new WorkspaceCoreError(
      "installation.update-in-progress",
      "HoneyBee is updating or application activity ownership was lost. Try again after the update finishes.",
    );
  let rejectReady: (error: Error) => void = () => {};
  const finished = new Promise<void>((resolve) =>
    child.once("close", () => {
      if (!released) controller.abort(unavailable());
      rejectReady(unavailable());
      resolve();
    }),
  );
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    child.once("error", (error) => {
      controller.abort(error);
      reject(error);
    });
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
      const normalized = output.replaceAll("\r\n", "\n");
      if (normalized === "HELD\n") resolve();
      else if (!"HELD\n".startsWith(normalized)) {
        controller.abort(unavailable());
        reject(unavailable());
        child.kill();
      }
    });
  });
  const timer = setTimeout(() => {
    rejectReady(unavailable());
    child.kill();
  }, 15000);
  const release = async (): Promise<void> => {
    released = true;
    child.stdin.end();
    const stop = setTimeout(() => child.kill(), 5000);
    try {
      await finished;
    } finally {
      clearTimeout(stop);
    }
  };
  try {
    await ready;
    await assertCombinedAdmission(path.resolve(releaseRoot, "../.."), validationId);
    await assertApplicationRepairAdmission(path.resolve(releaseRoot, "../.."));
  } catch (error) {
    await release();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    signal: controller.signal,
    release,
    assertHeld: () => {
      if (
        released ||
        controller.signal.aborted ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw unavailable();
    },
  };
};
