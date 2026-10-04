import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceCoreError } from "@honeybee/core";
import type * as CoreModule from "@honeybee/core";
import type * as CommandModule from "./workspace-command.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@honeybee/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  acquireInstalledActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./workspace-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CommandModule>()),
  runWorkspaceCli: mocks.run,
}));

const originalArgs = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each(["workspace.cleanup-pending", "workspace.in-use"])(
  "prints removal retry instructions for %s without asking for repair",
  async (code) => {
    process.argv = [process.execPath, "cli.js", "workspace", "remove", "orphaned"];
    process.exitCode = undefined;
    const message = 'Workspace directory "C:/workspaces/orphaned" cleanup is incomplete.';
    const instruction =
      code === "workspace.in-use"
        ? "Close tools using this directory and check its access permissions."
        : "Back up remaining contents before manually cleaning up the path.";
    mocks.run.mockRejectedValueOnce(
      new WorkspaceCoreError(code, message, {
        remediation: [instruction, 'Run honeybee workspace remove "orphaned" again.'],
      }),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("./cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    const output = String(stderr.mock.calls[0]?.[0]);
    expect(output).toContain(`Error [${code}]`);
    expect(output).toContain(message);
    expect(output).toContain(instruction);
    expect(output).toContain('workspace remove "orphaned"');
    expect(output).not.toContain("workspace repair");
  },
);

it("keeps unknown commit diagnostics in the CLI JSON error envelope", async () => {
  process.argv = [process.execPath, "cli.js", "cache", "prepare", "--json"];
  process.exitCode = undefined;
  const message =
    "Storage may still be working; requestId=commit-1; transactionId=tx-1; timeoutMs=600000; elapsedMs=600000";
  mocks.run.mockRejectedValueOnce(
    new WorkspaceCoreError("storage.commit-outcome-unknown", message),
  );
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await import("./cli.js");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(stderr).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
    schemaVersion: 1,
    ok: false,
    code: "storage.commit-outcome-unknown",
    message,
  });
});
