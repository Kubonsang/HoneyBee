import assert from "node:assert/strict";
import test from "node:test";
import { verifyColdBackup } from "./cold-backup.mjs";

const fixture = () => ({
  files: [
    {
      relative: "maintenance\\operation.lock",
      bytes: 0,
      sha256: "a".repeat(64),
      sddl: "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)S:(AU;FA;FA;;;WD)",
    },
  ],
  directories: [{ relative: "maintenance", sddl: "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" }],
});
const copied = (original) => {
  const value = globalThis.structuredClone(original);
  for (const kind of ["files", "directories"])
    value[kind][0].sddl = value[kind][0].sddl.replace("D:P(", "D:PAI(");
  return value;
};
test("cold backup allows only the two pinned protected DACL AI differences", () => {
  const original = fixture();
  const backup = copied(original);
  const before = globalThis.structuredClone(backup);
  assert.equal(verifyColdBackup(original, original).exceptions.length, 0);
  assert.equal(verifyColdBackup(original, backup).exceptions.length, 2);
  assert.deepEqual(backup, before);
});
test("cold backup rejects identity, rights, audit, protection, content and path changes", () => {
  for (const alter of [
    (v) => {
      v.files[0].sddl = v.files[0].sddl.replace("O:BA", "O:SY");
    },
    (v) => {
      v.files[0].sddl = v.files[0].sddl.replace("G:BA", "G:SY");
    },
    (v) => {
      v.files[0].sddl = v.files[0].sddl.replace("D:PAI", "D:AI");
    },
    (v) => {
      v.files[0].sddl = v.files[0].sddl.replace(";;;BA)", ";;;WD)");
    },
    (v) => {
      v.files[0].sddl = v.files[0].sddl.replace("S:(AU;FA;FA;;;WD)", "");
    },
    (v) => {
      v.files[0].sha256 = "b".repeat(64);
    },
    (v) => {
      v.files[0].bytes = 1;
    },
    (v) => {
      v.files[0].relative = "maintenance\\other.lock";
    },
    (v) => {
      v.files.push({ ...v.files[0] });
    },
  ]) {
    const original = fixture();
    const backup = copied(original);
    alter(backup);
    assert.throws(() => verifyColdBackup(original, backup));
  }
  for (const kind of ["files", "directories"]) {
    const original = fixture();
    original[kind][0].relative = "elsewhere";
    assert.throws(() => verifyColdBackup(original, copied(original)));
  }
});
