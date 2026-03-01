import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(scriptDir, "..");
const distDir = resolve(extensionRoot, "dist");
const firefoxDistDir = resolve(distDir, "firefox");

function run(command, args, cwd = extensionRoot) {
  globalThis.console.log(`[package-artifacts] ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function requireExistingFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function requireVersion() {
  const rawVersion = process.env.OPENERRATA_EXTENSION_PACKAGE_VERSION?.trim();
  if (!rawVersion) {
    throw new Error("OPENERRATA_EXTENSION_PACKAGE_VERSION is required (for artifact file naming).");
  }

  if (!/^[0-9A-Za-z._-]+$/.test(rawVersion)) {
    throw new Error(
      `OPENERRATA_EXTENSION_PACKAGE_VERSION must contain only [0-9A-Za-z._-], received: ${rawVersion}`,
    );
  }

  return rawVersion;
}

function resolveOutputDir() {
  const rawOutputDir = process.env.OPENERRATA_EXTENSION_PACKAGE_OUT_DIR?.trim();
  const outputDir = resolve(rawOutputDir && rawOutputDir.length > 0 ? rawOutputDir : process.cwd());
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function resolveCrxSigningKeyPath(tempDir) {
  const explicitKeyPath = process.env.OPENERRATA_CHROME_CRX_KEY_PATH?.trim();
  if (explicitKeyPath) {
    const absoluteKeyPath = resolve(explicitKeyPath);
    requireExistingFile(absoluteKeyPath, "Chrome CRX signing key");
    return absoluteKeyPath;
  }

  const privateKeyPem = process.env.OPENERRATA_CHROME_CRX_PRIVATE_KEY;
  if (typeof privateKeyPem === "string" && privateKeyPem.trim().length > 0) {
    const normalizedPrivateKeyPem =
      privateKeyPem.includes("\\n") && !privateKeyPem.includes("\n")
        ? privateKeyPem.replaceAll("\\n", "\n")
        : privateKeyPem;
    const keyPath = resolve(tempDir, "chrome-extension-key.pem");
    const privateKeyWithFinalNewline = normalizedPrivateKeyPem.endsWith("\n")
      ? normalizedPrivateKeyPem
      : `${normalizedPrivateKeyPem}\n`;
    writeFileSync(keyPath, privateKeyWithFinalNewline, { mode: 0o600 });
    return keyPath;
  }

  // Fall back to a transient key so CI can always produce a CRX artifact.
  run("pnpm", ["dlx", "crx@5.0.1", "keygen", tempDir]);
  const generatedKeyPath = resolve(tempDir, "key.pem");
  requireExistingFile(generatedKeyPath, "generated Chrome CRX signing key");
  return generatedKeyPath;
}

function zipDirectory(sourceDir, outputArchivePath) {
  run("zip", ["-rq", outputArchivePath, "."], sourceDir);
}

function packageChromeCrx(chromeSourceDir, keyPath, outputCrxPath) {
  run("pnpm", [
    "dlx",
    "crx@5.0.1",
    "pack",
    chromeSourceDir,
    "--private-key",
    keyPath,
    "--output",
    outputCrxPath,
    "--crx-version",
    "3",
  ]);
}

function removeIfExists(filePath) {
  rmSync(filePath, { force: true });
}

function reportArtifact(label, artifactPath) {
  requireExistingFile(artifactPath, label);
  const sizeBytes = statSync(artifactPath).size;
  if (sizeBytes <= 0) {
    throw new Error(`${label} was created but empty: ${artifactPath}`);
  }

  globalThis.console.log(`[package-artifacts] ${label}: ${artifactPath} (${sizeBytes} bytes)`);
}

const packageVersion = requireVersion();
const outputDir = resolveOutputDir();

requireExistingFile(resolve(distDir, "manifest.json"), "Chrome manifest build artifact");
requireExistingFile(resolve(firefoxDistDir, "manifest.json"), "Firefox manifest build artifact");

const chromeZipPath = resolve(outputDir, `openerrata-extension-chrome-${packageVersion}.zip`);
const chromeCrxPath = resolve(outputDir, `openerrata-extension-chrome-${packageVersion}.crx`);
const firefoxZipPath = resolve(outputDir, `openerrata-extension-firefox-${packageVersion}.zip`);
const firefoxXpiPath = resolve(outputDir, `openerrata-extension-firefox-${packageVersion}.xpi`);

for (const artifactPath of [chromeZipPath, chromeCrxPath, firefoxZipPath, firefoxXpiPath]) {
  removeIfExists(artifactPath);
}

const tempDir = mkdtempSync(resolve(tmpdir(), "openerrata-extension-package-"));
try {
  zipDirectory(distDir, chromeZipPath);
  zipDirectory(firefoxDistDir, firefoxZipPath);
  copyFileSync(firefoxZipPath, firefoxXpiPath);
  globalThis.console.log(
    `[package-artifacts] copied ${basename(firefoxZipPath)} -> ${basename(firefoxXpiPath)}`,
  );

  const crxSigningKeyPath = resolveCrxSigningKeyPath(tempDir);
  packageChromeCrx(distDir, crxSigningKeyPath, chromeCrxPath);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

reportArtifact("Chrome zip", chromeZipPath);
reportArtifact("Chrome crx", chromeCrxPath);
reportArtifact("Firefox zip", firefoxZipPath);
reportArtifact("Firefox xpi", firefoxXpiPath);
