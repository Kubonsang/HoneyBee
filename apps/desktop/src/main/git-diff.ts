import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { DesktopMainError } from "./desktop-errors.js";

export const MAX_DIFF_BYTES = 1024 * 1024;

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
  return new Promise<{ workspaceId: string; path?: string; content: string; truncated: boolean }>(
    (resolve, reject) => {
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
        });
      });
    },
  );
};
