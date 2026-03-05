import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const FIVE_MEBIBYTES = 5 * 1024 * 1024;

const DIST_DIRECTORY_BUDGETS = [
  {
    label: "Firefox dist directory",
    kind: "directory",
    relativePath: "dist/firefox",
    maxBytes: FIVE_MEBIBYTES,
  },
];

function packageArtifactBudgets(packageVersion) {
  return [
    {
      label: "Chrome zip artifact",
      kind: "file",
      relativePath: `openerrata-extension-chrome-${packageVersion}.zip`,
      maxBytes: FIVE_MEBIBYTES,
    },
    {
      label: "Chrome crx artifact",
      kind: "file",
      relativePath: `openerrata-extension-chrome-${packageVersion}.crx`,
      maxBytes: FIVE_MEBIBYTES,
    },
    {
      label: "Firefox zip artifact",
      kind: "file",
      relativePath: `openerrata-extension-firefox-${packageVersion}.zip`,
      maxBytes: FIVE_MEBIBYTES,
    },
  ];
}

function formatBytes(bytes) {
  const mebibytes = bytes / 1048576;
  return `${bytes} bytes (${mebibytes.toFixed(2)} MiB)`;
}

function directorySizeBytes(directoryPath) {
  let totalBytes = 0;
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      totalBytes += directorySizeBytes(entryPath);
      continue;
    }
    if (entry.isFile()) {
      totalBytes += statSync(entryPath).size;
    }
  }
  return totalBytes;
}

function directorySizeBytesExcludingTopLevelChild(directoryPath, excludedChildName) {
  let totalBytes = 0;
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === excludedChildName) {
      continue;
    }

    const entryPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      totalBytes += directorySizeBytes(entryPath);
      continue;
    }
    if (entry.isFile()) {
      totalBytes += statSync(entryPath).size;
    }
  }
  return totalBytes;
}

function readMeasuredBytes(pathKind, absolutePath) {
  if (pathKind === "directory") {
    return directorySizeBytes(absolutePath);
  }
  return statSync(absolutePath).size;
}

function assertSizeBudgets(rootDirectory, budgets, subjectLabel) {
  const failures = [];

  for (const budget of budgets) {
    const absolutePath = resolve(rootDirectory, budget.relativePath);
    if (!existsSync(absolutePath)) {
      failures.push(`${budget.label} is missing: ${absolutePath}`);
      continue;
    }

    const measuredBytes = readMeasuredBytes(budget.kind, absolutePath);
    if (measuredBytes > budget.maxBytes) {
      failures.push(
        `${budget.label} exceeds ${formatBytes(budget.maxBytes)}; measured ${formatBytes(measuredBytes)}.`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`${subjectLabel} size budget check failed:\n${failures.join("\n")}`);
  }
}

export function assertDistBundleSizeBudgets(extensionRoot) {
  const distDirectoryPath = resolve(extensionRoot, "dist");
  const failures = [];

  if (!existsSync(distDirectoryPath)) {
    failures.push(`Chrome dist directory is missing: ${distDirectoryPath}`);
  } else {
    const chromeDistBytes = directorySizeBytesExcludingTopLevelChild(distDirectoryPath, "firefox");
    if (chromeDistBytes > FIVE_MEBIBYTES) {
      failures.push(
        `Chrome dist directory exceeds ${formatBytes(FIVE_MEBIBYTES)}; measured ${formatBytes(chromeDistBytes)}.`,
      );
    }
  }

  try {
    assertSizeBudgets(extensionRoot, DIST_DIRECTORY_BUDGETS, "Dist bundle");
  } catch (error) {
    if (error instanceof Error) {
      failures.push(error.message);
    } else {
      failures.push(String(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Dist bundle size budget check failed:\n${failures.join("\n")}`);
  }
}

export function assertPackagedArtifactSizeBudgets(outputDirectory, packageVersion) {
  assertSizeBudgets(outputDirectory, packageArtifactBudgets(packageVersion), "Packaged artifact");
}
