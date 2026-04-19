import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    exclude: ["@fedimint/core", "@fedimint/transport-web"],
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
  server: {
    port: 3000,
  },
});
