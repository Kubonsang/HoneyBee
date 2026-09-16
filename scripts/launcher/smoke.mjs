import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32", "Launcher smoke requires Windows");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(path.join(tmpdir(), "honeybee-launcher-한글-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invoke = (executable, args, input = "") =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd: root, windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

try {
  await mkdir(path.join(root, "bin"));
  for (const relative of ["HoneyBeeLauncher.exe", "bin/honeybee.exe"]) {
    await copyFile(
      path.join(repository, "output", "launcher", relative),
      path.join(root, relative),
    );
  }
  const shim = path.join(root, "bin", "honeybee.exe");
  const launcher = path.join(root, "HoneyBeeLauncher.exe");
  const launcherBefore = hash(await readFile(launcher));
  const shimBefore = hash(await readFile(shim));
  const runtimeDigest = hash(await readFile(process.execPath));
  const generations = [];
  for (const [index, version] of ["0.1.0-beta.11", "0.1.0-beta.12"].entries()) {
    const directory = path.join(root, "versions", version);
    for (const subdirectory of ["desktop", "runtime", "cli/dist"]) {
      await mkdir(path.join(directory, subdirectory), { recursive: true });
    }
    // Node stands in for Desktop only inside this disposable transport fixture.
    await copyFile(process.execPath, path.join(directory, "desktop", "HoneyBee.exe"));
    await copyFile(process.execPath, path.join(directory, "runtime", "node.exe"));
    const cli = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({version: ${JSON.stringify(version)}, args: process.argv.slice(2), cwd: process.cwd(), input})); process.stderr.write('fixture-stderr'); process.exitCode = 17; });\n`;
    await writeFile(path.join(directory, "cli", "dist", "cli.js"), cli);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      version,
      desktopSha256: runtimeDigest,
      nodeSha256: runtimeDigest,
      cliSha256: hash(cli),
    });
    await writeFile(path.join(directory, "launch.json"), manifest);
    generations.push({
      schemaVersion: 1,
      generation: index + 1,
      activeVersion: version,
      manifestSha256: hash(manifest),
    });
  }
  const args = [
    "workspace",
    "path",
    "한글 space",
    'embedded"quote',
    "",
    "trailing\\",
    "&echo unsafe",
  ];
  for (const current of generations) {
    await writeFile(path.join(root, "current.json"), JSON.stringify(current));
    const result = await invoke(shim, args, "stdin 한글");
    assert.equal(result.code, 17);
    assert.equal(result.stderr, "fixture-stderr");
    assert.deepEqual(JSON.parse(result.stdout), {
      version: current.activeVersion,
      args,
      cwd: root,
      input: "stdin 한글",
    });
  }
  const desktopProbe = path.join(root, "desktop probe.cjs");
  const desktopResult = path.join(root, "desktop-result.json");
  await writeFile(
    desktopProbe,
    "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({exe:process.execPath,args:process.argv.slice(3)}));\n",
  );
  assert.equal((await invoke(launcher, [desktopProbe, desktopResult, ...args])).code, 0);
  let observed;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    observed = await readFile(desktopResult, "utf8").catch(() => undefined);
    if (observed !== undefined) break;
    await delay(100);
  }
  assert.notEqual(observed, undefined, "Desktop child did not start");
  assert.deepEqual(JSON.parse(observed), {
    exe: path.join(root, "versions", "0.1.0-beta.12", "desktop", "HoneyBee.exe"),
    args,
  });
  await writeFile(path.join(root, "current.json"), "{broken");
  const invalid = await invoke(shim, ["--version"]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /HoneyBee could not launch/);
  assert.equal(await readFile(path.join(root, "current.json"), "utf8"), "{broken");
  assert.equal(hash(await readFile(launcher)), launcherBefore);
  assert.equal(hash(await readFile(shim)), shimBefore);
  process.stdout.write("Stable Launcher/CLI A/B and argument/stream smoke passed.\n");
} finally {
  // Only the exact temporary fixture root created above is owned by this test.
  const relative = path.relative(tmpdir(), root);
  assert(!relative.startsWith("..") && !path.isAbsolute(relative) && relative.length > 0);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
