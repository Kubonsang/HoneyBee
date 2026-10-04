import assert from "node:assert/strict";

// These are the two observed robocopy /COPYALL differences on this host.
// No general SDDL normalization: even another equivalent ACE ordering is refused.
const descriptors = {
  directories: { maintenance: "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" },
  files: { "maintenance\\operation.lock": "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)" },
};

export function verifyColdBackup(expected, actual) {
  const normalized = globalThis.structuredClone(actual);
  const exceptions = [];
  for (const kind of ["files", "directories"]) {
    assert(Array.isArray(expected[kind]) && Array.isArray(actual[kind]), "Inventory required");
    assert.equal(actual[kind].length, expected[kind].length, "Inventory count differs");
    const seen = new Set();
    for (let i = 0; i < expected[kind].length; i++) {
      const original = expected[kind][i];
      const backup = normalized[kind][i];
      assert(!seen.has(original.relative), "Duplicate inventory path");
      seen.add(original.relative);
      assert.equal(backup.relative, original.relative, "Inventory path differs");
      assert.equal(typeof original.sddl, "string", "Security descriptor required");
      if (original.sddl === backup.sddl) continue;
      const pinned = Object.hasOwn(descriptors[kind], original.relative)
        ? descriptors[kind][original.relative]
        : undefined;
      assert(pinned, `Backup ACL differs: ${original.relative}`);
      // A captured SACL must be preserved verbatim, including its control flags.
      assert(
        original.sddl === pinned || original.sddl.startsWith(pinned + "S:"),
        "Unreviewed original ACL",
      );
      const expectedBackup = original.sddl.replace("O:BAG:BAD:P(", "O:BAG:BAD:PAI(");
      assert.equal(backup.sddl, expectedBackup, "Difference is not the reviewed DACL AI flag");
      exceptions.push({ kind, relative: original.relative, reason: "protected DACL AI flag only" });
      backup.sddl = original.sddl;
    }
  }
  assert.deepEqual(normalized, expected, "Backup content or inventory differs");
  return { passed: true, exceptions };
}
