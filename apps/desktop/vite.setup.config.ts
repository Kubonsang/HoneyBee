import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => "node:" + name)]);
export default defineConfig({
  build: {
    target: "node24",
    lib: {
      entry: "../../scripts/update/setup-worker-entry.mjs",
      formats: ["es"],
      fileName: () => "setup-worker.mjs",
    },
    minify: false,
    outDir: "dist/setup",
    rollupOptions: { external: (id) => builtins.has(id) },
  },
});
