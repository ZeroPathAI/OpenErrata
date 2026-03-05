import { resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import {
  assertDistBundleSizeBudgets,
  assertPackagedArtifactSizeBudgets,
} from "./size-budgets.mjs";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(scriptDir, "..");

function readMode() {
  const mode = process.argv[2];
  if (mode === "dist" || mode === "artifacts") {
    return mode;
  }

  throw new Error("Usage: node scripts/assert-size-budgets.mjs <dist|artifacts>");
}

function readPackageVersion() {
  const packageVersion = process.env.OPENERRATA_EXTENSION_PACKAGE_VERSION?.trim();
  if (!packageVersion) {
    throw new Error(
      "OPENERRATA_EXTENSION_PACKAGE_VERSION is required when running artifact size budget checks.",
    );
  }
  return packageVersion;
}

function resolveOutputDirectory() {
  const rawOutputDirectory = process.env.OPENERRATA_EXTENSION_PACKAGE_OUT_DIR?.trim();
  if (!rawOutputDirectory) {
    return process.cwd();
  }
  return resolve(rawOutputDirectory);
}

function main() {
  const mode = readMode();
  if (mode === "dist") {
    assertDistBundleSizeBudgets(extensionRoot);
    globalThis.console.log("Dist bundle size budgets passed.");
    return;
  }

  const packageVersion = readPackageVersion();
  const outputDirectory = resolveOutputDirectory();
  assertPackagedArtifactSizeBudgets(outputDirectory, packageVersion);
  globalThis.console.log("Packaged artifact size budgets passed.");
}

try {
  main();
} catch (error) {
  if (error instanceof Error) {
    globalThis.console.error(error.message);
  } else {
    globalThis.console.error(String(error));
  }
  process.exit(1);
}
