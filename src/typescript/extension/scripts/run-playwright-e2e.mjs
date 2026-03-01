import { spawnSync } from "node:child_process";
import process from "node:process";

const PLAYWRIGHT_ARGS = [
  "exec",
  "playwright",
  "test",
  "-c",
  "playwright.config.ts",
  ...process.argv.slice(2),
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { status: null, notFound: true };
    }
    throw result.error;
  }
  return { status: result.status ?? 1, notFound: false };
}

function runPlaywright() {
  const preferXvfb = process.env["OPENERRATA_PREFER_XVFB"] !== "0";
  if (preferXvfb) {
    process.stderr.write("[extension:e2e] attempting to run under xvfb-run.\n");
    const xvfbResult = run("xvfb-run", ["-a", "pnpm", ...PLAYWRIGHT_ARGS]);
    if (!xvfbResult.notFound) {
      return xvfbResult;
    }
    if (process.platform === "linux") {
      process.stderr.write(
        "[extension:e2e] xvfb-run not found on Linux; running without virtual display.\n",
      );
    }
  }

  return run("pnpm", PLAYWRIGHT_ARGS);
}

const result = runPlaywright();
process.exit(result.status ?? 1);
