import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../update/release-manifest.mjs";
import { combinedUpdateIdentity } from "../update/combined-update.mjs";
import { reviewCancelledHandoff } from "./review-cancelled-handoff.mjs";

for (const mode of ["cancelled", "native", "journal", "changed-pointer", "changed-request"]) {
  test(`handoff evidence rejects unsafe continuation: ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hb-handoff-review-"));
    const put = async (file, value) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), JSON.stringify(value));
    };
    const source = { activeVersion: "0.1.0-beta.31" };
    const bytes = Buffer.from(JSON.stringify(source));
    const identity = {
      manifestSha256: "a".repeat(64),
      sourcePointerSha256: sha256(bytes),
      serviceTransactionSha256: "b".repeat(64),
    };
    const id = combinedUpdateIdentity(identity);
    const inputs = {
      servicePair: { source, target: { version: "0.1.0-beta.32" } },
      updates: [{ manifestSha256: identity.manifestSha256 }],
    };
    inputs.servicePair.source = { version: source.activeVersion };
    await put("current.json", mode === "changed-pointer" ? { ...source, generation: 5 } : source);
    await put(`update/combined-contexts/${id}.json`, {
      identity,
      sourcePointer: bytes.toString("base64"),
      targetPointer: Buffer.from(JSON.stringify({ activeVersion: "0.1.0-beta.32" })).toString(
        "base64",
      ),
    });
    const request = { sourcePointerSha256: identity.sourcePointerSha256 };
    await put("update/jobs/job-test/request.json", request);
    await put("update/jobs/job-test/combined-transaction.json", {
      identitySha256: id,
      requestSha256: mode === "changed-request" ? "c".repeat(64) : sha256(JSON.stringify(request)),
    });
    if (mode === "native")
      await put(`update/service-contexts/${identity.serviceTransactionSha256}/native.json`, {});
    if (mode === "journal") await put(`update/combined/${id}/01.json`, { state: "Prepared" });
    if (mode === "cancelled")
      assert.equal((await reviewCancelledHandoff(root, inputs)).cancelledBeforeAdmission, true);
    else await assert.rejects(reviewCancelledHandoff(root, inputs));
  });
}
