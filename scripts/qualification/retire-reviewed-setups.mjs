import assert from "node:assert/strict";
import { readFile, readdir, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { plainDirectory } from "../update/stage-release.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { durableQARecord } from "./interruption-matrix.mjs";
const json = async (p) => JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/, ""));
async function completedBaseline(root) {
  const history = await Promise.all(
    (await readdir(path.join(root, "Evidence")))
      .filter((n) => n.endsWith(".json"))
      .map((n) => json(path.join(root, "Evidence", n))),
  );
  assert(
    history.some(
      (e) =>
        e.phase === "baseline-setup" && e.state === "Completed" && e.result.doctor.ready === true,
    ),
  );
}
export async function retireReviewedSetups(root) {
  assert.equal(root.toLowerCase(), "c:\\honeybeeqa\\remaining-six-20260917");
  await completedBaseline(root);
  const spec = await json(path.join(root, "retained-setup-copies.json"));
  const allowed = new Map([
    [
      path.join(root, "HoneyBeeSetup-qualification-baseline.exe"),
      "df622648d8740bf0198026c28c2d8a7d2bdd3c76add7c1d197358c7caaf0d504",
    ],
    [
      "C:\\HoneyBeeQA\\fresh-beta35\\HoneyBeeSetup.exe",
      "643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04",
    ],
  ]);
  assert.equal(spec.files.length, 2);
  const proof = await json("C:\\HoneyBeeQA\\fresh-beta35\\Evidence-fresh35-uac\\completed.json");
  assert.equal(proof.freshSetupPassed, true);
  assert.equal(proof.setupSha256, allowed.get("C:\\HoneyBeeQA\\fresh-beta35\\HoneyBeeSetup.exe"));
  for (const file of spec.files) {
    assert.equal(allowed.get(file.guestPath), file.sha256);
    assert.equal(file.hostCopyVerified, true);
    assert(file.hostPath.startsWith("C:\\Users\\user\\Documents\\HoneyBee\\output\\"));
    await plainDirectory(path.dirname(file.guestPath));
    const receiptPath = path.join(root, `retired-setup-${file.sha256}.json`);
    let exists = true;
    try {
      await lstat(file.guestPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      exists = false;
    }
    if (exists) {
      const stat = await lstat(file.guestPath);
      assert(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.size, file.size);
      assert.equal(sha256(await readFile(file.guestPath)), file.sha256);
      await durableQARecord(receiptPath, {
        schemaVersion: 1,
        ...file,
        reason: "Completed Setup payload; identical host package retained",
        deletionAuthorizedAfterVerification: true,
      });
      await unlink(file.guestPath);
    } else {
      const receipt = await json(receiptPath);
      assert.equal(receipt.sha256, file.sha256);
      assert.equal(receipt.hostPath, file.hostPath);
    }
  }
  process.stdout.write(
    "Two completed Setup duplicates retired from the VM; exact host packages and all installation/evidence data retained.\n",
  );
}
export async function isRetiredBaseline(root, artifact) {
  if (artifact.destination !== "HoneyBeeSetup-qualification-baseline.exe") return false;
  const receiptPath = path.join(root, `retired-setup-${artifact.sha256}.json`);
  let receipt;
  try {
    receipt = await json(receiptPath);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  await completedBaseline(root);
  assert.equal(receipt.guestPath, path.join(root, artifact.destination));
  assert.equal(receipt.sha256, artifact.sha256);
  assert.equal(receipt.size, artifact.size);
  assert.equal(receipt.hostCopyVerified, true);
  assert.equal(
    await lstat(receipt.guestPath).then(
      () => true,
      (e) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    ),
    false,
  );
  return true;
}
