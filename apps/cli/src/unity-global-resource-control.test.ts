import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EventIdSchema, ResourceIdSchema, RunIdSchema } from "@honeybee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileUnityResourceCoordinator } from "./unity-global-resource-control.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "honeybee-global-resource-"));
  directories.push(root);
  return root;
};

const request = (resourceId: string, requestId = randomUUID()) => ({
  resourceId: ResourceIdSchema.parse(resourceId),
  requestId: EventIdSchema.parse(requestId),
  ownerRunId: RunIdSchema.parse(randomUUID()),
});

const coordinatorModuleUrl = new URL("../dist/unity-global-resource-control.js", import.meta.url)
  .href;

const acquireInChild = async (
  root: string,
  value: ReturnType<typeof request>,
): Promise<Readonly<{ output: Promise<string>; exited: Promise<number | null> }>> => {
  const script = [
    `import { FileUnityResourceCoordinator } from ${JSON.stringify(coordinatorModuleUrl)};`,
    "const root = process.argv[1];",
    "const request = JSON.parse(process.argv[2]);",
    "const coordinator = new FileUnityResourceCoordinator(root);",
    "await coordinator.enqueue(request);",
    "const lease = await coordinator.acquire(request);",
    "process.stdout.write(JSON.stringify(lease) + '\\n');",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, root, JSON.stringify(value)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  const output = new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u)[0];
      if (line !== undefined && line.length > 0) resolve(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (stdout.length === 0 && code !== 0) reject(new Error(stderr || `child exited ${code}`));
    });
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { output, exited };
};

describe("FileUnityResourceCoordinator", () => {
  it("retries a directory snapshot that omits an event published by the same coordinator", async () => {
    const root = await temporaryRoot();
    let hidPublishedSnapshot = false;
    const coordinator = new FileUnityResourceCoordinator(
      root,
      () => new Date(),
      randomUUID,
      async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true });
        if (!hidPublishedSnapshot && entries.length > 0) {
          hidPublishedSnapshot = true;
          return [];
        }
        return entries;
      },
    );
    const original = request("unity-editor");

    await coordinator.enqueue(original);
    const lease = await coordinator.acquire(original);

    expect(hidPublishedSnapshot).toBe(true);
    expect(lease.requestId).toBe(original.requestId);
    await coordinator.release(lease);
  });

  it.skipIf(process.platform !== "win32")(
    "retries a transient Windows sharing violation when reading an immutable event",
    async () => {
      const root = await temporaryRoot();
      const coordinator = new FileUnityResourceCoordinator(root);
      const original = request("unity-editor");
      await coordinator.enqueue(original);
      const eventPath = path.join(
        root,
        ".unity-resources",
        "v1",
        "unity-editor",
        "events",
        "00000000000000000001.json",
      );
      const escapedEventPath = eventPath.replaceAll("'", "''");
      const script = [
        `$stream = [System.IO.File]::Open('${escapedEventPath}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)`,
        "[Console]::Out.WriteLine('locked')",
        "Start-Sleep -Milliseconds 300",
        "$stream.Dispose()",
      ].join("; ");
      const locker = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const exited = new Promise<void>((resolve, reject) => {
        locker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(String(code)))));
      });
      const locked = new Promise<void>((resolve, reject) => {
        locker.stdout.setEncoding("utf8");
        locker.stdout.once("data", () => resolve());
        locker.once("error", reject);
        locker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`locker exited ${code}`));
        });
      });
      await locked;

      expect((await coordinator.status(original)).state).toBe("queued");
      await exited;
    },
    10_000,
  );

  it("serializes one resource across processes and preserves an orphaned active lease", async () => {
    const root = await temporaryRoot();
    const coordinator = new FileUnityResourceCoordinator(root);
    const firstRequest = request("unity-editor");
    const secondRequest = request("unity-editor");

    const firstChild = await acquireInChild(root, firstRequest);
    const firstLease = JSON.parse(await firstChild.output) as Awaited<
      ReturnType<FileUnityResourceCoordinator["acquire"]>
    >;
    expect(await firstChild.exited).toBe(0);
    expect(await coordinator.status(firstRequest)).toEqual({
      state: "active",
      lease: firstLease,
    });

    const secondChild = await acquireInChild(root, secondRequest);
    let secondSettled = false;
    void secondChild.output.then(() => {
      secondSettled = true;
    });
    await vi.waitFor(async () => {
      expect((await coordinator.status(secondRequest)).state).toBe("queued");
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);

    await coordinator.release(firstLease);
    const secondLease = JSON.parse(await secondChild.output) as Awaited<
      ReturnType<FileUnityResourceCoordinator["acquire"]>
    >;
    expect(secondLease.ticket).toBe(2);
    expect(await secondChild.exited).toBe(0);
    await coordinator.release(secondLease);
    expect((await coordinator.status(secondRequest)).state).toBe("released");
  }, 30_000);

  it("allows distinct resources concurrently and cancels queued requests durably", async () => {
    const root = await temporaryRoot();
    const first = new FileUnityResourceCoordinator(root);
    const second = new FileUnityResourceCoordinator(root);
    const editor = request("unity-editor");
    const license = request("unity-license");
    const waiting = request("unity-editor");
    await Promise.all([first.enqueue(editor), second.enqueue(license)]);
    await second.enqueue(waiting);

    const [editorLease, licenseLease] = await Promise.all([
      first.acquire(editor),
      second.acquire(license),
    ]);
    await second.cancel(waiting);
    expect(await first.status(waiting)).toMatchObject({ state: "cancelled" });
    await expect(first.acquire(waiting)).rejects.toMatchObject({
      code: "agent.cancelled",
    });
    await Promise.all([second.release(editorLease), first.release(licenseLease)]);
  }, 30_000);

  it("fails closed on journal gaps and request ownership reuse", async () => {
    const root = await temporaryRoot();
    const coordinator = new FileUnityResourceCoordinator(root);
    const original = request("unity-editor");
    await coordinator.enqueue(original);
    await expect(
      coordinator.enqueue({ ...original, ownerRunId: RunIdSchema.parse(randomUUID()) }),
    ).rejects.toMatchObject({ code: "validation.invalid-workflow" });
    const events = path.join(root, ".unity-resources", "v1", "unity-editor", "events");
    await mkdir(events, { recursive: true });
    await writeFile(path.join(events, "00000000000000000003.json"), "{}\n", "utf8");
    await expect(coordinator.status(original)).rejects.toMatchObject({
      code: "run.indeterminate",
    });
  });

  it.each([
    ["resource root", [".unity-resources"]],
    ["resource version", [".unity-resources", "v1"]],
    ["resource directory", [".unity-resources", "v1", "unity-editor"]],
    ["event directory", [".unity-resources", "v1", "unity-editor", "events"]],
    ["temporary directory", [".unity-resources", "v1", "unity-editor", "tmp"]],
    ["lock root", [".unity-resource-locks"]],
    ["lock version", [".unity-resource-locks", "v1"]],
    ["lease root", [".unity-resource-locks", "v1", ".leases"]],
    ["active lease directory", [".unity-resource-locks", "v1", ".leases", "active"]],
    ["candidate lease directory", [".unity-resource-locks", "v1", ".leases", "candidates"]],
    ["stale lease directory", [".unity-resource-locks", "v1", ".leases", "stale"]],
    ["released lease directory", [".unity-resource-locks", "v1", ".leases", "released"]],
  ] as const)(
    "rejects a link at the %s before publishing outside the state root",
    async (_name, parts) => {
      const root = await temporaryRoot();
      const target = path.join(root, `link-target-${randomUUID()}`);
      const linkPath = path.join(root, ...parts);
      await Promise.all([mkdir(target), mkdir(path.dirname(linkPath), { recursive: true })]);
      await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
      const coordinator = new FileUnityResourceCoordinator(root);

      await expect(coordinator.enqueue(request("unity-editor"))).rejects.toMatchObject({
        code: "run.indeterminate",
      });
      expect(await readdir(target)).toEqual([]);
    },
  );
});
