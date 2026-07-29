import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@vscode/test-cli";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  files: "test/suite/**/*.test.cjs",
  version: "stable",
  extensionDevelopmentPath: extensionRoot,
  workspaceFolder: path.join(extensionRoot, "test", "workspace"),
  launchArgs: ["--disable-extensions"],
  mocha: { timeout: 20_000 },
});
