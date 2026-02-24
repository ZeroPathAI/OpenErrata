import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(scriptDir, "..");
const distDir = resolve(extensionRoot, "dist");

const errors = [];

function fail(message) {
  errors.push(message);
}

function readRequiredDistFile(relativePath) {
  const absolutePath = resolve(distDir, relativePath);
  if (!existsSync(absolutePath)) {
    fail(`Missing build artifact: ${relativePath}`);
    return "";
  }

  return readFileSync(absolutePath, "utf8");
}

const manifestRaw = readRequiredDistFile("manifest.json");
if (manifestRaw.length > 0) {
  const manifest = JSON.parse(manifestRaw);
  const declaredContentScriptPath = manifest?.content_scripts?.[0]?.js?.[0];
  if (declaredContentScriptPath !== "content/main.js") {
    fail(
      `Unexpected content script entry in manifest: ${String(declaredContentScriptPath)}`,
    );
  }

  const backgroundServiceWorker = manifest?.background?.service_worker;
  if (backgroundServiceWorker !== "background/index.js") {
    fail(
      `Unexpected background service worker entry in manifest: ${String(backgroundServiceWorker)}`,
    );
  }
}

const contentScript = readRequiredDistFile("content/main.js");
if (/^\s*import\s/m.test(contentScript) || /^\s*export\s/m.test(contentScript)) {
  fail(
    "dist/content/main.js contains ESM syntax. MV3 content scripts must be bundled as classic scripts.",
  );
}

const backgroundScript = readRequiredDistFile("background/index.js");
if (/from\s*["'](?![./])/.test(backgroundScript)) {
  fail(
    "dist/background/index.js contains bare module imports that Chrome extension workers cannot resolve.",
  );
}

if (errors.length > 0) {
  for (const message of errors) {
    globalThis.console.error(`Build verification failed: ${message}`);
  }
  process.exit(1);
}

globalThis.console.log("Build verification passed.");
