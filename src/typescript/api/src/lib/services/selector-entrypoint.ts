import { runStartupChecks } from "$lib/config/startup.js";
import { prisma } from "$lib/db/client";
import { runSelector } from "./selector.js";

async function runOnce(): Promise<void> {
  let exitCode = 0;
  try {
    await runStartupChecks("selector");
    const count = await runSelector();
    console.log(`Selector: enqueued ${count} investigations`);
  } catch (err) {
    console.error("Selector error:", err);
    exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch (disconnectError) {
      console.error("Failed to disconnect Prisma in selector:", disconnectError);
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}

console.log("Running TrueSight selector once...");
void runOnce();
