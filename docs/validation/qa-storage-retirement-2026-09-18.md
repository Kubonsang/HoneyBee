# QA artifact retention, 2026-09-18

Obsolete generated QA payloads were retired after release qualification.
Duplicate binaries were removed only after verifying a retained copy with the
same SHA-256. Source files, release artifacts and qualification evidence were
preserved.

Older generated build directories should be treated as evidence archives, not
as runnable installations. Reconstruct any retired payload from its recorded
canonical copy and verify its hash before reuse.

The cleanup did not change the published beta.35 assets or product source.
Detailed local inventories and retirement journals remain outside the public
repository.
