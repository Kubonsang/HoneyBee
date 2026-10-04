import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { composeBeta37Native } from "./compose-beta36-native.mjs";

export { composeBeta37Native };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await composeBeta37Native(process.argv[2], process.argv[3])
    .then((receipt) => {
      process.stdout.write(
        JSON.stringify({
          status: receipt.status,
          cases: receipt.coverage.passed.length,
          regressions: receipt.regressions,
        }) + "\n",
      );
    })
    .catch((error) => {
      process.stderr.write(error.stack + "\n");
      process.exitCode = 1;
    });
