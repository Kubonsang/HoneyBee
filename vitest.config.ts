import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**", "**/.vscode-test/**"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
