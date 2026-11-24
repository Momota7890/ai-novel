import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Builds the Manifest V3 content script as a self-contained IIFE so Chrome/Edge
 * can inject `dist/content.js` without top-level ES module imports, and copies
 * `overlay.css` into `dist/overlay.css`.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "src/content/index.ts"),
      output: {
        format: "iife",
        name: "RealtimeTranslatorContent",
        entryFileNames: "content.js",
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    {
      name: "copy-content-overlay-css",
      closeBundle() {
        const distDir = resolve(__dirname, "dist");
        mkdirSync(distDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, "src/content/styles/overlay.css"),
          resolve(distDir, "overlay.css"),
        );
      },
    },
  ],
});
