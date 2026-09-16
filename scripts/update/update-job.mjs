import assert from "node:assert/strict";
import { mkdir, mkdtemp, open } from "node:fs/promises";
import path from "node:path";
import { plainDirectory } from "./stage-release.mjs";
import { readBounded } from "./prepare-release.mjs";
import { sha256 } from "./release-manifest.mjs";

export async function createPrepareJob({ installationRoot, stageAttempt, manifestSha256 }) {
  const root = path.resolve(installationRoot),
    stage = path.resolve(stageAttempt);
  assert.equal(path.dirname(stage), path.join(root, "update"));
  assert(/^stage-[A-Za-z0-9]+$/u.test(path.basename(stage)));
  assert(/^[a-f0-9]{64}$/u.test(manifestSha256));
  await plainDirectory(stage);
  assert.equal(sha256(await readBounded(path.join(stage, "release.json"))), manifestSha256);
  const pointer = await readBounded(path.join(root, "current.json"));
  const jobs = path.join(root, "update/jobs");
  await mkdir(jobs, { recursive: true });
  await plainDirectory(jobs);
  const directory = await mkdtemp(path.join(jobs, "job-"));
  const bytes = JSON.stringify({
    schemaVersion: 1,
    operation: "prepare",
    stage: path.basename(stage),
    manifestSha256,
    sourcePointerSha256: sha256(pointer),
  });
  const file = await open(path.join(directory, "request.json"), "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return { directory, name: path.basename(directory), sha256: sha256(bytes) };
}

export async function createActivationJob({
  installationRoot,
  preparation,
  desktopDescriptor,
  setupActivation = false,
}) {
  const root = path.resolve(installationRoot);
  let desktopSession;
  if (setupActivation) assert.equal(desktopDescriptor, undefined);
  else {
    const descriptor = path.resolve(desktopDescriptor);
    assert.equal(path.dirname(descriptor), path.join(root, "update/desktop-sessions"));
    desktopSession = path.basename(descriptor, ".json");
    assert(/^[a-f0-9-]{36}$/u.test(desktopSession));
  }
  assert(
    /^job-[A-Za-z0-9]+$/u.test(preparation.name) && /^[a-f0-9]{64}$/u.test(preparation.sha256),
  );
  const jobs = path.join(root, "update/jobs");
  await plainDirectory(jobs);
  const prior = await readBounded(path.join(jobs, preparation.name, "request.json"));
  assert.equal(sha256(prior), preparation.sha256);
  const pointer = await readBounded(path.join(root, "current.json"));
  assert.equal(sha256(pointer), JSON.parse(prior).sourcePointerSha256);
  const directory = await mkdtemp(path.join(jobs, "job-"));
  const bytes = JSON.stringify({
    schemaVersion: 1,
    operation: setupActivation ? "setup-activate" : "activate",
    preparationJob: preparation.name,
    preparationSha256: preparation.sha256,
    sourcePointerSha256: sha256(pointer),
    ...(setupActivation ? {} : { desktopSession }),
    launcherSha256: sha256(
      await readBounded(path.join(root, "HoneyBeeLauncher.exe"), 8 * 1024 * 1024),
    ),
  });
  const file = await open(path.join(directory, "request.json"), "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return { directory, name: path.basename(directory), sha256: sha256(bytes) };
}
