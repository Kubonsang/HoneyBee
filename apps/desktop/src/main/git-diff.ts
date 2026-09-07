import { execFile, spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { DesktopMainError } from "./desktop-errors.js";

export const MAX_DIFF_BYTES = 1024 * 1024;
const exec = promisify(execFile);
export type DiffKind = "patch" | "untracked" | "binary" | "empty";

async function previewUntracked(workspacePath: string, relativePath: string) {
  const root = await realpath(workspacePath);
  const target = path.resolve(root, relativePath);
  const verifyPath = async () => {
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new DesktopMainError("git.diff-path-invalid", "File preview cannot follow links.");
    }
    if ((await realpath(target)).toLowerCase() !== target.toLowerCase())
      throw new DesktopMainError("git.diff-path-invalid", "File preview escaped its path.");
  };
  await verifyPath();
  const file = await open(target, "r");
  try {
    const info = await file.stat();
    const current = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || info.ino !== current.ino || info.dev !== current.dev)
      throw new DesktopMainError(
        "git.diff-path-invalid",
        "File preview requires an unlinked regular file.",
      );
    const buffer = Buffer.alloc(MAX_DIFF_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    await verifyPath();
    const truncated = length > MAX_DIFF_BYTES;
    const bytes = buffer.subarray(0, Math.min(length, MAX_DIFF_BYTES));
    if (bytes.includes(0)) return { content: "", truncated, kind: "binary" as const };
    const decoder = new StringDecoder("utf8");
    const content = decoder.write(bytes) + (truncated ? "" : decoder.end());
    return { content, truncated, kind: "untracked" as const };
  } finally {
    await file.close();
  }
}

const normalizedDiffPath = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    value.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new DesktopMainError(
      "git.diff-path-invalid",
      "Diff path must stay inside the Workspace.",
    );
  }
  return normalized;
};

export const readDiff = async (
  workspace: { workspaceId: string; workspacePath: string },
  requestedPath?: string,
) => {
  const relativePath = normalizedDiffPath(requestedPath);
  if (relativePath !== undefined) {
    const { stdout } = await exec(
      "git.exe",
      [
        "-c",
        `safe.directory=${workspace.workspacePath.replaceAll("\\", "/")}`,
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        relativePath,
      ],
      {
        cwd: workspace.workspacePath,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (stdout.split("\0").includes(relativePath))
      return {
        workspaceId: workspace.workspaceId,
        path: relativePath,
        ...(await previewUntracked(workspace.workspacePath, relativePath)),
      };
  }
  return new Promise<{
    workspaceId: string;
    path?: string;
    content: string;
    truncated: boolean;
    kind: DiffKind;
  }>((resolve, reject) => {
    const child = spawn(
      "git.exe",
      [
        "-c",
        `safe.directory=${workspace.workspacePath.replaceAll("\\", "/")}`,
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        ...(relativePath === undefined ? [] : [relativePath]),
      ],
      {
        cwd: workspace.workspacePath,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = MAX_DIFF_BYTES - length;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        length += kept.length;
      }
      if (chunk.length > remaining && !truncated) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || (!truncated && code !== 0)) {
        reject(
          new DesktopMainError(
            "git.diff-failed",
            timedOut ? "Git diff timed out." : stderr.trim() || "Git diff failed.",
          ),
        );
        return;
      }
      const decoder = new StringDecoder("utf8");
      const content = decoder.write(Buffer.concat(chunks)) + (truncated ? "" : decoder.end());
      resolve({
        workspaceId: workspace.workspaceId,
        ...(relativePath === undefined ? {} : { path: relativePath }),
        content,
        truncated,
        kind:
          content.length === 0
            ? "empty"
            : relativePath !== undefined && /^Binary files .+ differ$/mu.test(content)
              ? "binary"
              : "patch",
      });
    });
  });
};
