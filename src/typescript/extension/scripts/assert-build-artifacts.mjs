import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { Script } from "node:vm";

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

function assertParsesAsClassicScript(relativePath) {
  const source = readRequiredDistFile(relativePath);
  if (source.length === 0) {
    return;
  }

  try {
    // Validate artifact syntax in classic-script mode (no static import/export).
    new Script(source, { filename: relativePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${relativePath} is not a valid classic script: ${message}`);
  }
}

function verifyChromeManifest() {
  const manifestRaw = readRequiredDistFile("manifest.json");
  if (manifestRaw.length === 0) {
    return;
  }

  const manifest = JSON.parse(manifestRaw);
  const declaredContentScriptPath = manifest?.content_scripts?.[0]?.js?.[0];
  if (declaredContentScriptPath !== "content/main.js") {
    fail(
      `Unexpected Chrome content script entry in manifest: ${String(declaredContentScriptPath)}`,
    );
  }

  const backgroundServiceWorker = manifest?.background?.service_worker;
  if (backgroundServiceWorker !== "background/index.js") {
    fail(
      `Unexpected Chrome background service worker entry in manifest: ${String(backgroundServiceWorker)}`,
    );
  }
}

function verifyFirefoxManifest() {
  const manifestRaw = readRequiredDistFile("firefox/manifest.json");
  if (manifestRaw.length === 0) {
    return;
  }

  const manifest = JSON.parse(manifestRaw);
  if (manifest?.manifest_version !== 3) {
    fail(`Unexpected Firefox manifest_version: ${String(manifest?.manifest_version)}`);
  }

  const declaredContentScriptPath = manifest?.content_scripts?.[0]?.js?.[0];
  if (declaredContentScriptPath !== "content/main.js") {
    fail(
      `Unexpected Firefox content script entry in manifest: ${String(declaredContentScriptPath)}`,
    );
  }

  const backgroundScripts = manifest?.background?.scripts;
  if (!Array.isArray(backgroundScripts) || backgroundScripts[0] !== "background/index.js") {
    fail(`Unexpected Firefox background scripts entry in manifest: ${String(backgroundScripts)}`);
  }

  if (manifest?.background?.persistent !== false) {
    fail(
      `Unexpected Firefox background.persistent value: ${String(manifest?.background?.persistent)}`,
    );
  }

  if (manifest?.background?.service_worker !== undefined) {
    fail("Firefox manifest must not declare background.service_worker.");
  }

  const geckoId = manifest?.browser_specific_settings?.gecko?.id;
  if (typeof geckoId !== "string" || geckoId.length === 0) {
    fail("Firefox manifest missing browser_specific_settings.gecko.id.");
  }

  assertParsesAsClassicScript("firefox/background/index.js");
  assertParsesAsClassicScript("firefox/content/main.js");
}

verifyChromeManifest();
verifyFirefoxManifest();

assertParsesAsClassicScript("content/main.js");

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
