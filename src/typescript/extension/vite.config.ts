import { defineConfig, build, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";

/**
 * After the main build, run a second build for the content script as IIFE.
 * MV3 content scripts can't use ES module imports — they load as classic scripts.
 */
function buildContentScript(): Plugin {
  return {
    name: "build-content-script",
    async closeBundle() {
      await build({
        configFile: false,
        plugins: [svelte()],
        build: {
          outDir: resolve(__dirname, "dist/content"),
          emptyOutDir: false,
          lib: {
            entry: resolve(__dirname, "src/content/main.ts"),
            formats: ["iife"],
            name: "OpenErrataContent",
            fileName: () => "main.js",
          },
          rollupOptions: {
            output: {
              // Inline everything — no external imports
              inlineDynamicImports: true,
            },
          },
          // Don't clear the dist/content dir (annotations.css is already there)
          minify: true,
          sourcemap: false,
        },
        resolve: {
          alias: {
            "@openerrata/shared": resolve(__dirname, "../shared/src"),
          },
        },
      });
    },
  };
}

/**
 * Copies static extension assets into dist/.
 */
function copyExtensionAssets(): Plugin {
  function assertHtmlHasStylesheet(
    htmlPath: string,
    expectedCssPath: string,
  ): void {
    const html = readFileSync(htmlPath, "utf8");
    if (!html.includes(`href="${expectedCssPath}"`)) {
      throw new Error(
        `Missing stylesheet link (${expectedCssPath}) in ${htmlPath}`,
      );
    }
  }

  return {
    name: "copy-extension-assets",
    closeBundle() {
      const dist = resolve(__dirname, "dist");

      copyFileSync(
        resolve(__dirname, "src/manifest.json"),
        resolve(dist, "manifest.json"),
      );

      mkdirSync(resolve(dist, "content"), { recursive: true });
      copyFileSync(
        resolve(__dirname, "src/content/annotations.css"),
        resolve(dist, "content/annotations.css"),
      );

      // Vite emits HTML entries under dist/src/... because our source HTML lives in src/.
      // Mirror those files into the manifest paths expected by MV3.
      mkdirSync(resolve(dist, "popup"), { recursive: true });
      copyFileSync(
        resolve(dist, "src/popup/index.html"),
        resolve(dist, "popup/index.html"),
      );
      assertHtmlHasStylesheet(resolve(dist, "popup/index.html"), "/index.css");

      mkdirSync(resolve(dist, "options"), { recursive: true });
      copyFileSync(
        resolve(dist, "src/options/index.html"),
        resolve(dist, "options/index.html"),
      );
      assertHtmlHasStylesheet(resolve(dist, "options/index.html"), "/index2.css");

      rmSync(resolve(dist, "src"), { recursive: true, force: true });
    },
  };
}

// Main build: background (ES module), popup, options.
// Content script is built separately as IIFE via the buildContentScript plugin.
export default defineConfig({
  plugins: [svelte(), buildContentScript(), copyExtensionAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/index": resolve(__dirname, "src/background/index.ts"),
        "popup/index": resolve(__dirname, "src/popup/index.html"),
        "options/index": resolve(__dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
});
