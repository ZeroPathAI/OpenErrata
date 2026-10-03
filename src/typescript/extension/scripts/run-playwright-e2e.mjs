import { spawnSync } from "node:child_process";
import process from "node:process";

// The suite launches Chromium headless (new headless mode via
// `channel: "chromium"`), which loads extensions without a display, so no
// virtual display (xvfb) is needed on any platform.
const result = spawnSync(
  "pnpm",
  ["exec", "playwright", "test", "-c", "playwright.config.ts", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
