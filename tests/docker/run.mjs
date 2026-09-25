import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, open, readFile, writeFile, unlink, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  digest,
  inventory,
  git,
  hostSpace,
  policy,
} from "../../scripts/qualification/release-verification.mjs";

const builder = "honeybee-verification";
export async function runDocker({
  root,
  directory,
  source,
  distribution = "Ubuntu-24.04",
  suite = "portable",
}) {
  assert(["portable", "contract"].includes(suite));
  directory = path.resolve(directory);
  assert(
    directory.startsWith(path.join(path.resolve(root), "output") + path.sep),
    "Evidence must be below output/",
  );
  await mkdir(directory, { recursive: true });
  const lease = path.join(root, "output", "docker-verification.lock");
  const lock = await open(lease, "wx");
  const windows = process.platform === "win32";
  const hosted =
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
  const freeFloor = hosted ? 2 * 1024 ** 3 : policy.hostPauseFreeBytes;
  const peakAllowance = hosted ? 8 * 1024 ** 3 : policy.builderCacheTargetBytes + 3 * 1024 ** 3;
  const wslPrefix = ["-d", distribution, "-u", "root", "--exec"];
  const capture = (command, args) =>
    execFileSync(windows ? "wsl.exe" : command, windows ? [...wslPrefix, command, ...args] : args, {
      encoding: "utf8",
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 ** 2,
    }).trim();
  const linuxPath = (file) =>
    windows ? capture("wslpath", ["-a", "-u", path.resolve(file)]) : path.resolve(file);
  const logged = async (command, args, name) => {
    const log = await open(path.join(directory, name), "wx");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          windows ? "wsl.exe" : command,
          windows ? [...wslPrefix, command, ...args] : args,
          { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        // Sequential stream writes preserve diagnostic output without buffering a whole build.
        let writes = Promise.resolve();
        const output = (bytes) => {
          process.stdout.write(bytes);
          writes = writes.then(() => log.write(bytes));
        };
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        child.on("error", reject);
        child.on("close", (code) =>
          writes.then(
            () => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))),
            reject,
          ),
        );
      });
    } finally {
      await log.close();
    }
  };
  const receipt = {
    schemaVersion: 1,
    lane: "docker",
    source,
    status: "failed",
    suite,
    environment: {
      platform: process.platform,
      distribution: windows ? distribution : null,
      hosted,
      hostFreeFloorBytes: freeFloor,
    },
    unexpectedSkips: null,
    attachments: [],
    startedAt: new Date().toISOString(),
    evidenceDirectory: directory,
    nativeWindowsQualification: false,
  };
  let engineStarted = false;
  let builderReady = false;
  const image = `honeybee-verification-${suite}:${source.inventorySha256.slice(0, 16)}`;
  try {
    assert(
      (await hostSpace(root)) > freeFloor + peakAllowance,
      "Host free-space guard refused Docker build",
    );
    const context = path.join(directory, "context");
    execFileSync(process.execPath, [path.join(root, "tests/docker/stage-context.mjs"), context], {
      cwd: root,
      stdio: "inherit",
    });
    await copyFile(
      path.join(context, "source-inventory.json"),
      path.join(directory, "source-inventory.json"),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "source-inventory.json"), "utf8"))
        .sourceInventorySha256,
      source.inventorySha256,
      "Source changed between planning and Docker staging",
    );
    if (windows) {
      let running = false;
      try {
        running = capture("systemctl", ["is-active", "docker"]) === "active";
      } catch {
        /* inactive */
      }
      if (!running) {
        capture("systemctl", ["start", "docker"]);
        engineStarted = true;
      }
    }
    assert.equal(
      capture("docker", ["info", "--format", "{{.OSType}}"]),
      "linux",
      "Linux engine required",
    );
    let existing;
    try {
      existing = capture("docker", ["buildx", "inspect", builder]);
    } catch {
      /* absent builder */
    }
    if (existing)
      assert(
        /^Driver:\s+docker-container\s*$/mu.test(existing),
        "Dedicated builder driver differs",
      );
    else
      capture("docker", [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--buildkitd-config",
        linuxPath(
          path.join(
            root,
            hosted ? "tests/docker/buildkitd-ci.toml" : "tests/docker/buildkitd.toml",
          ),
        ),
      ]);
    builderReady = true;
    capture("docker", ["buildx", "inspect", builder, "--bootstrap"]);
    const builderConfig = capture("docker", [
      "exec",
      `buildx_buildkit_${builder}0`,
      "cat",
      "/etc/buildkit/buildkitd.toml",
    ]);
    assert(
      /maxUsedSpace\s*=\s*["']8GB["']/u.test(builderConfig) &&
        (hosted ? /minFreeSpace\s*=\s*["']2GB["']/u : /minFreeSpace\s*=\s*["']20GB["']/u).test(
          builderConfig,
        ),
      "Existing builder has a different storage policy; explicit migration required",
    );
    await writeFile(path.join(directory, "builder-policy.txt"), builderConfig);
    const dockerfile = suite === "portable" ? "portable.Dockerfile" : "Dockerfile";
    await logged(
      "docker",
      [
        "buildx",
        "build",
        "--builder",
        builder,
        "--load",
        "--progress",
        "plain",
        "--label",
        "com.honeybee.verification=true",
        "-f",
        linuxPath(path.join(context, "tests/docker", dockerfile)),
        "-t",
        image,
        linuxPath(context),
      ],
      "build.log",
    );
    const identity = capture("docker", ["image", "inspect", image]);
    await writeFile(path.join(directory, "image.json"), identity);
    receipt.imageDigest = JSON.parse(identity)[0].Id;
    assert((await hostSpace(root)) > freeFloor, "Host free-space guard refused Docker test");
    await logged(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        `honeybee-verification-${randomUUID()}`,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        suite === "portable" ? "4g" : "1g",
        "--cpus",
        "2",
        "--pids-limit",
        "512",
        image,
      ],
      "test.log",
    );
    if (suite === "portable") {
      const summary = execFileSync(
        process.execPath,
        [path.join(root, "tests/docker/summarize.mjs"), path.join(directory, "test.log")],
        { cwd: root, encoding: "utf8" },
      );
      await writeFile(path.join(directory, "test-summary.json"), summary);
      const parsed = JSON.parse(summary);
      assert(
        parsed.stages?.length >= 28 && parsed.stages.every((stage) => stage.ok),
        "Missing/failed stage summary",
      );
      assert.equal(parsed.coverage?.unexpectedSkips, 0, "Missing/failed coverage audit");
      receipt.coverage = parsed.coverage;
      receipt.unexpectedSkips = parsed.coverage.unexpectedSkips;
      receipt.status = "passed";
      // Retain failed run images. Only retire images from prior successful runs
      // made by this runner, after their source/log evidence has been retained.
      const historyPath = path.join(root, "output", "verification-image-history.json");
      let history = [];
      try {
        history = JSON.parse(await readFile(historyPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const prior = history.filter((item) => item.image !== image);
      const removed = [];
      const retained = [
        { image, id: receipt.imageDigest, result: path.join(directory, "result.json") },
        ...prior.slice(0, 1),
      ];
      for (const item of prior.slice(1)) {
        const old = JSON.parse(await readFile(item.result, "utf8"));
        assert.equal(old.status, "passed", "Cannot retire failed image evidence");
        assert(
          item.image.startsWith("honeybee-verification-") && /^sha256:[a-f0-9]{64}$/u.test(item.id),
          "Invalid image history",
        );
        let details;
        try {
          details = JSON.parse(capture("docker", ["image", "inspect", item.image]))[0];
        } catch {
          continue;
        }
        assert.equal(details.Id, item.id, "Retained image tag changed");
        assert.equal(details.Config.Labels?.["com.honeybee.verification"], "true");
        if (capture("docker", ["ps", "-a", "-q", "--filter", `ancestor=${item.id}`])) {
          retained.push(item);
          continue;
        }
        capture("docker", ["image", "rm", item.image]); // no force; only this exact owned tag
        removed.push(item.image);
      }
      await writeFile(
        path.join(directory, "image-retention.json"),
        JSON.stringify({ retained, removed }, null, 2),
      );
      await writeFile(historyPath, JSON.stringify(retained, null, 2));
      // Keep exact source bytes until a verified retained copy is registered.
      receipt.contextRetained = (await readdir(context)).length > 0;
    } else {
      receipt.status = "partial"; // focused tests never qualify the portable lane
    }
  } catch (error) {
    receipt.error = error.message;
  } finally {
    try {
      await writeFile(path.join(directory, "disk-usage.txt"), capture("docker", ["system", "df"]));
    } catch (error) {
      receipt.capacityInspectionError = error.message;
    }
    if (builderReady) {
      try {
        capture("docker", ["buildx", "stop", builder]);
      } catch (error) {
        receipt.builderStopError = error.message;
      }
    }
    if (engineStarted) {
      try {
        if (!capture("docker", ["ps", "-q"]))
          capture("systemctl", ["stop", "docker.service", "docker.socket", "containerd.service"]);
      } catch (error) {
        receipt.engineStopError = error.message;
      }
    }
    receipt.completedAt = new Date().toISOString();
    for (const name of [
      "source-inventory.json",
      "build.log",
      "test.log",
      "image.json",
      "test-summary.json",
      "disk-usage.txt",
      "builder-policy.txt",
      "image-retention.json",
    ]) {
      try {
        receipt.attachments.push({
          path: name,
          sha256: digest(await readFile(path.join(directory, name))),
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          receipt.status = "failed";
          receipt.evidenceError = error.message;
        }
      }
    }
    await writeFile(path.join(directory, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
    await lock.close();
    await unlink(lease);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "../..");
  const input = await inventory(root);
  const receipt = await runDocker({
    root,
    directory: process.argv[2] ?? path.join(root, "output", `verification-docker-${randomUUID()}`),
    source: { commit: git(root, ["rev-parse", "HEAD"]), inventorySha256: input.sha256 },
    suite: process.argv[3] ?? "portable",
    distribution: process.argv[4] ?? "Ubuntu-24.04",
  });
  process.stdout.write(
    JSON.stringify(
      {
        status: receipt.status,
        source: receipt.source,
        evidence: receipt.evidenceDirectory,
        error: receipt.error,
      },
      null,
      2,
    ) + "\n",
  );
  if (receipt.status !== "passed" && receipt.status !== "partial") process.exitCode = 1;
}
