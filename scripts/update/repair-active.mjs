import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, open, rename, readdir, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withInstallationUpdateLock } from "./installation-lock.mjs";
import { withApplicationActivity } from "./application-activity.mjs";
import { readBounded } from "./prepare-release.mjs";
import { plainDirectory } from "./stage-release.mjs";
import { sha256 } from "./release-manifest.mjs";
import { resolveRecoverySource, verifyRecoverySourceFiles } from "./recovery-source.mjs";

const present = async (name) => {
  try {
    await lstat(name);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const persist = async (name, bytes) => {
  const temporary = name + ".tmp-" + randomUUID();
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await link(temporary, name);
  await unlink(temporary);
};

/** Caller supplies a pinned recovery runtime (Launcher) or verified Setup runtime.
 * The source/previous directories contain application payloads only, never data. */
export async function recoverApplicationRepair({
  installationRoot,
  runtime,
  name,
  checkpoint = async () => {},
}) {
  assert(/^repair-[A-Za-z0-9]+$/u.test(name), "Invalid application Repair transaction");
  const root = path.resolve(installationRoot);
  return withInstallationUpdateLock(root, () =>
    withApplicationActivity(
      { installationRoot: root, mode: "exclusive", timeoutMs: 30000 },
      async ({ assertHeld }) => {
        const directory = path.join(root, "update/app-repairs", name);
        await plainDirectory(directory);
        const intentBytes = await readBounded(path.join(directory, "intent.json"));
        const intent = JSON.parse(intentBytes);
        assert.deepEqual(Object.keys(intent).sort(), [
          "schemaVersion",
          "sourcePointerSha256",
          "version",
        ]);
        assert.equal(intent.schemaVersion, 1);
        const pointerBytes = await readBounded(path.join(root, "current.json"));
        assert.equal(
          sha256(pointerBytes),
          intent.sourcePointerSha256,
          "Active version changed during Repair",
        );
        const pointer = JSON.parse(pointerBytes);
        assert.equal(pointer.activeVersion, intent.version);
        const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
        const active = path.join(root, "versions", approved.version);
        const candidateRoot = path.join(directory, "candidate");
        const candidate = path.join(candidateRoot, "versions", approved.version);
        const previous = path.join(directory, "previous-version");
        const completion = path.join(directory, "complete.json");
        const complete = { schemaVersion: 1, intentSha256: sha256(intentBytes) };
        if (await present(completion)) {
          assert.deepEqual(JSON.parse(await readBounded(completion)), complete);
          await verifyRecoverySourceFiles(root, approved);
          return { state: "Committed", directory };
        }
        if (await present(candidate)) {
          await verifyRecoverySourceFiles(candidateRoot, approved);
          assertHeld();
          assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
          if (await present(active)) {
            assert(
              !(await present(previous)),
              "Ambiguous Repair publication; existing files preserved",
            );
            await plainDirectory(active);
            await rename(active, previous);
            await checkpoint("preserved");
          }
          assertHeld();
          await plainDirectory(path.join(root, "versions"));
          assert(!(await present(active)), "Repair destination reappeared");
          await rename(candidate, active);
          await checkpoint("published");
        }
        await verifyRecoverySourceFiles(root, approved);
        assertHeld();
        assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
        await persist(completion, JSON.stringify(complete));
        return { state: "Committed", directory };
      },
    ),
  );
}

export async function prepareApplicationRepair({ installationRoot, sourceInstallation, runtime }) {
  const root = path.resolve(installationRoot);
  // Preparation is inactive. Publication obtains exclusive application activity.
  return withInstallationUpdateLock(root, async ({ assertHeld }) => {
    const pointerBytes = await readBounded(path.join(root, "current.json"));
    const pointer = JSON.parse(pointerBytes);
    assert.equal(pointer.schemaVersion, 1);
    assert(Number.isSafeInteger(pointer.generation) && pointer.generation > 0);
    const approved = await resolveRecoverySource({ installationRoot: root, runtime, pointer });
    await verifyRecoverySourceFiles(sourceInstallation, approved);
    const parent = path.join(root, "update/app-repairs");
    await mkdir(parent, { recursive: true });
    await plainDirectory(parent);
    const entries = await readdir(parent);
    assert(entries.length < 256, "Application Repair history limit reached");
    const pending = [];
    for (const name of entries) {
      assert(/^repair-[A-Za-z0-9]+$/u.test(name), "Unknown application Repair entry");
      const directory = path.join(parent, name);
      await plainDirectory(directory);
      if (
        (await present(path.join(directory, "intent.json"))) &&
        !(await present(path.join(directory, "complete.json")))
      )
        pending.push({ name, directory });
    }
    assert(pending.length <= 1, "Conflicting application Repair transactions");
    if (pending.length) return pending[0];
    const directory = await mkdtemp(path.join(parent, "repair-"));
    const candidateRoot = path.join(directory, "candidate");
    const candidate = path.join(candidateRoot, "versions", approved.version);
    await mkdir(path.dirname(candidate), { recursive: true });
    await cp(path.join(sourceInstallation, "versions", approved.version), candidate, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    await verifyRecoverySourceFiles(candidateRoot, approved);
    // Flush every staged file before making the repair intent visible.
    for (const name of Object.keys(approved.files)) {
      const file = await open(path.join(candidate, name), "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    assertHeld();
    assert.deepEqual(await readBounded(path.join(root, "current.json")), pointerBytes);
    const intent = {
      schemaVersion: 1,
      version: approved.version,
      sourcePointerSha256: sha256(pointerBytes),
    };
    await persist(path.join(directory, "intent.json"), JSON.stringify(intent));
    return { name: path.basename(directory), directory };
  });
}
