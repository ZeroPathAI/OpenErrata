import { getSelectorDailyBudget } from "$lib/config/runtime.js";
import { runStartupChecks } from "$lib/config/startup.js";
import { getPrisma } from "$lib/db/client";
import { runSelector } from "./selector.js";

async function runOnce(): Promise<void> {
  let exitCode = 0;
  try {
    await runStartupChecks("selector");
    const summary = await runSelector({ dailyBudget: getSelectorDailyBudget() });
    console.log(
      `Selector: admitted ${summary.admitted.toString()} (budget left today: ${summary.budgetRemaining.toString()}), re-enqueued ${summary.requeued.toString()}, recovered ${summary.recovered.toString()} expired lease(s)`,
    );
    for (const failure of summary.failures) {
      console.error(`Selector ${failure.stage} failed for ${failure.subjectId}:`, failure.error);
    }
    if (summary.failures.length > 0) {
      exitCode = 1;
    }
  } catch (err) {
    console.error("Selector error:", err);
    exitCode = 1;
  } finally {
    try {
      await getPrisma().$disconnect();
    } catch (disconnectError) {
      console.error("Failed to disconnect Prisma in selector:", disconnectError);
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}

console.log("Running OpenErrata selector once...");
void runOnce();
