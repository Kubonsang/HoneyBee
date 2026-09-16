import assert from "node:assert/strict";
import process from "node:process";
import { runUpdateTransaction } from "./update-transaction.mjs";
try {
  const [mode, installationRoot, planPath, planSha256, transactionDirectory, ...extra] =
    process.argv.slice(2);
  assert(
    ["validate", "recover", "abandon"].includes(mode) &&
      installationRoot &&
      planPath &&
      planSha256 &&
      !extra.length &&
      (mode === "validate" ? !transactionDirectory : transactionDirectory),
    "Usage: transaction.mjs validate ROOT PLAN SHA256 | recover|abandon ROOT PLAN SHA256 TRANSACTION_DIRECTORY",
  );
  const result = await runUpdateTransaction({
    installationRoot,
    planPath,
    planSha256,
    transactionDirectory,
    abandon: mode === "abandon",
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
