import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => "node:" + name)]);

export default defineConfig({
  build: {
    target: "node24",
    emptyOutDir: true,
    lib: {
      entry: "src/main/main.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    minify: false,
    outDir: "dist/main/main",
    rollupOptions: {
      external: (id) => id === "electron" || builtins.has(id),
    },
  },
});
