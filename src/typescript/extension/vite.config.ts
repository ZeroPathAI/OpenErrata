import { defineConfig, build, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import process from "node:process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

type ExtensionManifest = {
  background?: {
    persistent?: boolean;
    service_worker?: string;
    scripts?: string[];
    type?: string;
  };
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
    };
  };
  applications?: unknown;
  content_scripts?: Array<{
    js?: string[];
  }>;
};

const FIREFOX_GECKO_ID =
  process.env.FIREFOX_GECKO_ID !== undefined && process.env.FIREFOX_GECKO_ID.length > 0
    ? process.env.FIREFOX_GECKO_ID
    : "openerrata@openerrata.com";
const FIREFOX_MIN_VERSION = "109.0";

function cloneManifest(manifest: ExtensionManifest): ExtensionManifest {
  return JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
}

function toChromeManifest(manifest: ExtensionManifest): ExtensionManifest {
  const chromeManifest = cloneManifest(manifest);
  delete chromeManifest.browser_specific_settings;
  delete chromeManifest.applications;
  return chromeManifest;
}

function toFirefoxManifest(manifest: ExtensionManifest): ExtensionManifest {
  const firefoxManifest = cloneManifest(manifest);
  // Firefox MV3 currently runs background logic as event-page scripts.
  // Keep the Chrome service-worker entry out of the Firefox package.
  firefoxManifest.background = {
    scripts: ["background/index.js"],
    persistent: false,
  };
  firefoxManifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_GECKO_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
    },
  };
  delete firefoxManifest.applications;
  return firefoxManifest;
}

function copyBuiltExtensionToFirefoxDir(dist: string): void {
  const firefoxDist = resolve(dist, "firefox");
  rmSync(firefoxDist, { recursive: true, force: true });
  mkdirSync(firefoxDist, { recursive: true });

  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (entry.name === "firefox") continue;
    cpSync(resolve(dist, entry.name), resolve(firefoxDist, entry.name), {
      recursive: true,
    });
  }
}

async function buildFirefoxBackgroundBundle(outputDir: string): Promise<void> {
  await build({
    configFile: false,
    plugins: [svelte()],
    build: {
      outDir: outputDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "src/background/index.ts"),
        formats: ["iife"],
        name: "OpenErrataBackground",
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
      minify: true,
      sourcemap: false,
    },
    resolve: {
      alias: {
        "@openerrata/shared": resolve(__dirname, "../shared/src"),
      },
    },
  });
}

async function buildContentScriptBundle(outputDir: string): Promise<void> {
  await build({
    configFile: false,
    plugins: [svelte()],
    build: {
      outDir: outputDir,
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
}

/**
 * Copies static extension assets into dist/.
 */
function copyExtensionAssets(): Plugin {
  function assertHtmlHasStylesheet(htmlPath: string, expectedCssPath: string): void {
    const html = readFileSync(htmlPath, "utf8");
    if (!html.includes(`href="${expectedCssPath}"`)) {
      throw new Error(`Missing stylesheet link (${expectedCssPath}) in ${htmlPath}`);
    }
  }

  return {
    name: "copy-extension-assets",
    async closeBundle() {
      const dist = resolve(__dirname, "dist");
      const sourceManifestPath = resolve(__dirname, "src/manifest.json");
      const sourceManifest = JSON.parse(
        readFileSync(sourceManifestPath, "utf8"),
      ) as ExtensionManifest;

      // Content scripts must ship as classic scripts (IIFE) for both browsers.
      await buildContentScriptBundle(resolve(dist, "content"));

      writeFileSync(
        resolve(dist, "manifest.json"),
        `${JSON.stringify(toChromeManifest(sourceManifest), null, 2)}\n`,
      );

      // Copy extension icons
      const iconsSrc = resolve(__dirname, "src/icons");
      const iconsDist = resolve(dist, "icons");
      mkdirSync(iconsDist, { recursive: true });
      for (const file of readdirSync(iconsSrc)) {
        if (file.endsWith(".png")) {
          copyFileSync(resolve(iconsSrc, file), resolve(iconsDist, file));
        }
      }

      mkdirSync(resolve(dist, "content"), { recursive: true });
      copyFileSync(
        resolve(__dirname, "src/content/annotations.css"),
        resolve(dist, "content/annotations.css"),
      );

      // Vite emits HTML entries under dist/src/... because our source HTML lives in src/.
      // Mirror those files into the manifest paths expected by MV3.
      mkdirSync(resolve(dist, "popup"), { recursive: true });
      copyFileSync(resolve(dist, "src/popup/index.html"), resolve(dist, "popup/index.html"));
      assertHtmlHasStylesheet(resolve(dist, "popup/index.html"), "/index.css");

      mkdirSync(resolve(dist, "options"), { recursive: true });
      copyFileSync(resolve(dist, "src/options/index.html"), resolve(dist, "options/index.html"));
      assertHtmlHasStylesheet(resolve(dist, "options/index.html"), "/index2.css");

      rmSync(resolve(dist, "src"), { recursive: true, force: true });

      copyBuiltExtensionToFirefoxDir(dist);
      await buildFirefoxBackgroundBundle(resolve(dist, "firefox/background"));
      writeFileSync(
        resolve(dist, "firefox/manifest.json"),
        `${JSON.stringify(toFirefoxManifest(sourceManifest), null, 2)}\n`,
      );
    },
  };
}

// Main build: background (ES module), popup, options.
// Secondary artifacts (content IIFE + Firefox package) are assembled in copyExtensionAssets.
export default defineConfig({
  plugins: [svelte(), copyExtensionAssets()],
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
