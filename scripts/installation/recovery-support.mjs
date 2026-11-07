import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import support from "../../apps/desktop/resources/recovery-support-v1.json" with { type: "json" };

export const supportDocumentation = () =>
  [
    "<!-- recovery-support:start -->",
    "",
    "This table describes supported paths, not authorization. Setup and the native service must still admit each operation.",
    "",
    ...support.paths.map((item) => `- **${item.id}**: ${item.en} ${item.ko}`),
    "",
    "<!-- recovery-support:end -->",
  ].join("\n");

export async function synchronizeRecoverySupport(root, { check = false } = {}) {
  const file = path.join(root, "docs/operations/storage-recovery.md");
  const source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  const marker = /<!-- recovery-support:start -->[\s\S]*?<!-- recovery-support:end -->/u;
  const next = marker.test(source)
    ? source.replace(marker, supportDocumentation())
    : `${source}\n## Supported recovery paths\n\n${supportDocumentation()}\n`;
  assert(!check || next === source, "Recovery support guide differs; run pnpm support:sync");
  if (!check && next !== source) await writeFile(file, next);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await synchronizeRecoverySupport(path.resolve(import.meta.dirname, "../.."), {
    check: process.argv.includes("--check"),
  });
