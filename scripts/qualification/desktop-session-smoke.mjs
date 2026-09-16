import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDesktopUpdateTransport,
  readDesktopSession,
  requestDesktopSession,
} from "../update/desktop-session.mjs";
import { withApplicationActivity } from "../update/application-activity.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(
  JSON.parse(await readFile(path.join(repository, "output/two-version-qa/candidate.json")))
    .installation,
);
assert(root.startsWith(path.join(repository, "output/two-version-qa") + path.sep));
const pointer = await readFile(path.join(root, "current.json"));
const version = JSON.parse(pointer).activeVersion;
const base = path.join(repository, "output/desktop-session-smoke");
await mkdir(base, { recursive: true });
const evidence = await mkdtemp(path.join(base, "case-"));
const sessions = path.join(root, "update/desktop-sessions");
await mkdir(sessions, { recursive: true });
const previous = new Set(await readdir(sessions));
const logs = new Map();
const owned = [];
const launch = async (entry) => {
  const profile = path.join(evidence, entry);
  await mkdir(profile);
  const env = {
    ...process.env,
    TEMP: evidence,
    TMP: evidence,
    HONEYBEE_DESKTOP_SMOKE: "desktop-smoke-v2",
    HONEYBEE_DESKTOP_SESSION_SMOKE: "session-v1",
    HONEYBEE_DESKTOP_SMOKE_RESULT: path.join(profile, "result.json"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable =
    entry === "desktop"
      ? path.join(root, "versions", version, "desktop/HoneyBee.exe")
      : path.join(root, "HoneyBeeLauncher.exe");
  const child = spawn(
    executable,
    [
      "--user-data-dir=" + profile,
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-software-rasterizer",
      "--no-sandbox",
    ],
    { cwd: profile, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  logs.set(entry, "");
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => logs.set(entry, (logs.get(entry) + data.toString()).slice(-65536)));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
};
try {
  await launch("desktop");
  const deadline = Date.now() + 30000;
  let source;
  while (!source && Date.now() < deadline) {
    for (const name of await readdir(sessions)) {
      if (previous.has(name)) continue;
      try {
        const identity = await readDesktopSession(root, path.join(sessions, name));
        if (
          identity.version === version &&
          (await requestDesktopSession(identity, { operation: "status", timeoutMs: 1000 }))
            .status === "ready"
        ) {
          source = identity;
          owned.push(identity);
          break;
        }
      } catch {
        /* Startup records are not readiness until authenticated. */
      }
    }
    if (!source) await delay(100);
  }
  assert(source, "Packaged Desktop did not publish a ready session");
  const transport = await createDesktopUpdateTransport({
    installationRoot: root,
    descriptor: path.join(sessions, source.sessionId + ".json"),
  });
  const response = await requestDesktopSession(source, { operation: "shutdown", timeoutMs: 15000 });
  assert.equal(response.status, "accepted");
  await withApplicationActivity(
    { installationRoot: root, mode: "exclusive", timeoutMs: 10000 },
    async ({ assertHeld }) => assertHeld(),
  );
  await transport.prepareRestart();
  await launch("launcher");
  const ready = await transport.waitForReady({ version });
  assert.notEqual(ready.sessionId, source.sessionId);
  const next = await readDesktopSession(root, path.join(sessions, ready.sessionId + ".json"));
  owned.push(next);
  assert.equal(
    (await requestDesktopSession(next, { operation: "shutdown", timeoutMs: 15000 })).status,
    "accepted",
  );
  await withApplicationActivity(
    { installationRoot: root, mode: "exclusive", timeoutMs: 10000 },
    async ({ assertHeld }) => assertHeld(),
  );
  assert.deepEqual(await readFile(path.join(root, "current.json")), pointer);
  const result = {
    passed: true,
    version,
    shutdownAcknowledged: true,
    restart: ready,
    pointerPreserved: true,
    scope: "same-version packaged Desktop transport; no update or service mutation",
  };
  await writeFile(path.join(evidence, "qualification.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ evidence, ...result }, null, 2) + "\n");
} finally {
  for (const identity of owned)
    await requestDesktopSession(identity, { operation: "shutdown", timeoutMs: 1000 }).catch(
      () => {},
    );
  for (const [entry, text] of logs)
    await writeFile(path.join(evidence, entry, "process.log"), text);
}
