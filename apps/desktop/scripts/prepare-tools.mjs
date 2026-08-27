import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceStorageCommit = "e69fb8a0c55c91dee25274b3f40110b57fb538c4";
const workspaceStorageVersion = "0.0.0+e69fb8a0c55c.hb2";
const repository = "https://github.com/Kubonsang/unity-workspace-storage.git";
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..", "..");
const hostRoot = path.join(repositoryRoot, "tools", "workspace-storage-host");
const outputRoot = path.join(appRoot, ".tools", "win32-x64");
const clientOutput = path.join(outputRoot, "unity-workspace-storage.exe");
const hostOutput = path.join(outputRoot, "honeybee-workspace-storage-host.exe");

const run = async (command, args, options = {}) =>
  execFileAsync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: 10 * 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

const sha256 = async (target) =>
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex");

let temporary;
let sourceRoot =
  process.env.HONEYBEE_WORKSPACE_STORAGE_SOURCE ??
  path.resolve(repositoryRoot, "..", "unity-workspace-storage");
try {
  await access(path.join(sourceRoot, "go.mod"));
} catch {
  temporary = await mkdtemp(path.join(tmpdir(), "honeybee-workspace-storage-source-"));
  sourceRoot = path.join(temporary, "source");
  await run("git", ["clone", "--no-checkout", "--filter=blob:none", repository, sourceRoot]);
  await run("git", ["checkout", "--detach", workspaceStorageCommit], { cwd: sourceRoot });
}

try {
  const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
  if (revision !== workspaceStorageCommit) {
    throw new Error(
      "workspace-storage source must be pinned to " + workspaceStorageCommit + "; got " + revision,
    );
  }
  const dirty = (await run("git", ["status", "--porcelain"], { cwd: sourceRoot })).stdout.trim();
  if (dirty.length !== 0) {
    throw new Error("workspace-storage source has uncommitted changes.");
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const buildEnvironment = { CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" };
  await run(
    "go",
    [
      "build",
      "-buildvcs=false",
      "-trimpath",
      "-ldflags=-buildid=",
      "-o",
      clientOutput,
      "./cmd/unity-workspace-storage",
    ],
    { cwd: sourceRoot, env: buildEnvironment },
  );

  const workRoot = await mkdtemp(path.join(tmpdir(), "honeybee-go-work-"));
  try {
    const workFile = path.join(workRoot, "go.work");
    await run("go", ["work", "init", hostRoot, sourceRoot], { cwd: workRoot });
    await run(
      "go",
      ["build", "-buildvcs=false", "-trimpath", "-ldflags=-buildid=", "-o", hostOutput, "."],
      {
        cwd: hostRoot,
        env: { ...buildEnvironment, GOWORK: workFile },
      },
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }

  await writeFile(
    path.join(outputRoot, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        workspaceStorageVersion,
        workspaceStorageCommit,
        files: {
          "unity-workspace-storage.exe": {
            byteLength: (await stat(clientOutput)).size,
            sha256: await sha256(clientOutput),
          },
          "honeybee-workspace-storage-host.exe": {
            byteLength: (await stat(hostOutput)).size,
            sha256: await sha256(hostOutput),
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  process.stdout.write("Prepared pinned HoneyBee storage tools at " + outputRoot + "\n");
} finally {
  if (temporary !== undefined) {
    await rm(temporary, { recursive: true, force: true });
  }
}
