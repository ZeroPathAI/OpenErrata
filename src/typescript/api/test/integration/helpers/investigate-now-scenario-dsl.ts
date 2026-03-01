import {
  assert,
  buildXViewInput,
  createCaller,
  randomInt,
  seedInvestigationForXViewInput,
  seedInvestigationRun,
  sleep,
  withIntegrationPrefix,
} from "../api-endpoints.integration.shared.js";

const INVESTIGATE_NOW_FUZZ_SCENARIOS = [
  "NONE",
  "FAILED",
  "PENDING",
  "PROCESSING_STALE",
  "PROCESSING_ACTIVE",
  "COMPLETE",
] as const;

const INVESTIGATE_NOW_FUZZ_CALLER_MODES = ["authenticated", "user_key", "mixed"] as const;

type InvestigateNowFuzzScenario = (typeof INVESTIGATE_NOW_FUZZ_SCENARIOS)[number];
type InvestigateNowFuzzCallerMode = (typeof INVESTIGATE_NOW_FUZZ_CALLER_MODES)[number];
type FuzzRandom = () => number;
type XViewInput = ReturnType<typeof buildXViewInput>;
type InvestigateNowResult = Awaited<
  ReturnType<ReturnType<typeof createCaller>["post"]["investigateNow"]>
>;
type InvestigateNowStatus = InvestigateNowResult["status"];
type InvestigateNowCaller = ReturnType<typeof createCaller>;

interface InvestigateNowCallerPlan {
  jitterMs: number;
  caller: InvestigateNowCaller;
}

export interface InvestigateNowFuzzRoundScenario {
  roundTag: string;
  input: XViewInput;
  scenario: InvestigateNowFuzzScenario;
  callerMode: InvestigateNowFuzzCallerMode;
  callerPlans: readonly InvestigateNowCallerPlan[];
  expectedStoredStatus: InvestigateNowStatus;
  allowedReturnedStatuses: ReadonlySet<InvestigateNowStatus>;
  requiresPendingRecoveryEvidence: boolean;
  hasUserKeyCaller: boolean;
  seedExistingInvestigation: () => Promise<{ seededInvestigationId: string | null }>;
  runConcurrentInvestigateNow: () => Promise<{
    results: InvestigateNowResult[];
    investigationId: string;
    returnedStatuses: ReadonlySet<InvestigateNowStatus>;
  }>;
}

function pickFrom<TValue>(items: readonly TValue[], random: FuzzRandom): TValue {
  const selected = items[randomInt(random, 0, items.length - 1)];
  if (selected === undefined) {
    throw new Error("Invariant violation: failed to pick value from non-empty list");
  }
  return selected;
}

function seededInvestigationStatusForScenario(
  scenario: Exclude<InvestigateNowFuzzScenario, "NONE">,
): InvestigateNowStatus {
  switch (scenario) {
    case "COMPLETE":
      return "COMPLETE";
    case "FAILED":
      return "FAILED";
    case "PENDING":
      return "PENDING";
    case "PROCESSING_ACTIVE":
    case "PROCESSING_STALE":
      return "PROCESSING";
  }
}

function expectedStoredStatusForScenario(
  scenario: InvestigateNowFuzzScenario,
): InvestigateNowStatus {
  if (scenario === "COMPLETE") {
    return "COMPLETE";
  }
  if (scenario === "PROCESSING_ACTIVE") {
    return "PROCESSING";
  }
  return "PENDING";
}

function allowedReturnedStatusesForScenario(
  scenario: InvestigateNowFuzzScenario,
  expectedStoredStatus: InvestigateNowStatus,
): ReadonlySet<InvestigateNowStatus> {
  if (scenario === "PROCESSING_STALE") {
    return new Set(["PENDING", "PROCESSING"]);
  }
  return new Set([expectedStoredStatus]);
}

function hasUserKeyCallerForMode(callerMode: InvestigateNowFuzzCallerMode): boolean {
  return callerMode !== "authenticated";
}

function createCallerPlan(input: {
  callerMode: InvestigateNowFuzzCallerMode;
  round: number;
  index: number;
  jitterMs: number;
}): InvestigateNowCallerPlan {
  const viewerKey = withIntegrationPrefix(
    `fuzz-viewer-${input.round.toString()}-${input.index.toString()}`,
  );
  const ipRangeKey = withIntegrationPrefix(
    `fuzz-ip-${input.round.toString()}-${input.index.toString()}`,
  );

  if (input.callerMode === "authenticated") {
    return {
      jitterMs: input.jitterMs,
      caller: createCaller({
        isAuthenticated: true,
        viewerKey,
        ipRangeKey,
      }),
    };
  }

  if (input.callerMode === "user_key") {
    return {
      jitterMs: input.jitterMs,
      caller: createCaller({
        userOpenAiApiKey: `sk-test-fuzz-${input.round.toString()}-${input.index.toString()}`,
        viewerKey,
        ipRangeKey,
      }),
    };
  }

  if (input.index % 2 === 0) {
    return {
      jitterMs: input.jitterMs,
      caller: createCaller({
        isAuthenticated: true,
        viewerKey,
        ipRangeKey,
      }),
    };
  }

  return {
    jitterMs: input.jitterMs,
    caller: createCaller({
      userOpenAiApiKey: `sk-test-fuzz-mixed-${input.round.toString()}-${input.index.toString()}`,
      viewerKey,
      ipRangeKey,
    }),
  };
}

function buildCallerPlans(input: {
  callerMode: InvestigateNowFuzzCallerMode;
  callerCount: number;
  random: FuzzRandom;
  round: number;
}): InvestigateNowCallerPlan[] {
  return Array.from({ length: input.callerCount }, (_, index) =>
    createCallerPlan({
      callerMode: input.callerMode,
      round: input.round,
      index,
      jitterMs: randomInt(input.random, 0, 12),
    }),
  );
}

async function seedExistingInvestigationForScenario(input: {
  scenario: InvestigateNowFuzzScenario;
  viewInput: XViewInput;
  round: number;
}): Promise<{ seededInvestigationId: string | null }> {
  if (input.scenario === "NONE") {
    return { seededInvestigationId: null };
  }

  const seeded = await seedInvestigationForXViewInput({
    viewInput: input.viewInput,
    status: seededInvestigationStatusForScenario(input.scenario),
    provenance: "CLIENT_FALLBACK",
  });
  const now = Date.now();

  if (input.scenario === "PROCESSING_STALE") {
    await seedInvestigationRun({
      investigationId: seeded.investigationId,
      leaseOwner: withIntegrationPrefix(`stale-worker-${input.round.toString()}`),
      leaseExpiresAt: new Date(now - 10 * 60_000),
      startedAt: new Date(now - 20 * 60_000),
      heartbeatAt: new Date(now - 10 * 60_000),
    });
  }

  if (input.scenario === "PROCESSING_ACTIVE") {
    await seedInvestigationRun({
      investigationId: seeded.investigationId,
      leaseOwner: withIntegrationPrefix(`active-worker-${input.round.toString()}`),
      leaseExpiresAt: new Date(now + 10 * 60_000),
      startedAt: new Date(now - 60_000),
      heartbeatAt: new Date(now),
    });
  }

  return { seededInvestigationId: seeded.investigationId };
}

async function runConcurrentInvestigateNowWithPlans(input: {
  viewInput: XViewInput;
  callerPlans: readonly InvestigateNowCallerPlan[];
  roundTag: string;
}): Promise<{
  results: InvestigateNowResult[];
  investigationId: string;
  returnedStatuses: ReadonlySet<InvestigateNowStatus>;
}> {
  const results = await Promise.all(
    input.callerPlans.map(async ({ caller, jitterMs }) => {
      await sleep(jitterMs);
      return caller.post.investigateNow(input.viewInput);
    }),
  );

  const investigationIds = new Set(results.map((result) => result.investigationId));
  assert.equal(
    investigationIds.size,
    1,
    `all callers should converge to one investigation (${input.roundTag})`,
  );
  const firstResult = results[0];
  assert.ok(firstResult, `missing first result (${input.roundTag})`);

  return {
    results,
    investigationId: firstResult.investigationId,
    returnedStatuses: new Set(results.map((result) => result.status)),
  };
}

export function createInvestigateNowFuzzRoundScenario(input: {
  round: number;
  random: FuzzRandom;
}): InvestigateNowFuzzRoundScenario {
  const scenario = pickFrom(INVESTIGATE_NOW_FUZZ_SCENARIOS, input.random);
  const callerMode = pickFrom(INVESTIGATE_NOW_FUZZ_CALLER_MODES, input.random);
  const roundTag = `round=${input.round.toString()} scenario=${scenario} callerMode=${callerMode}`;
  const viewInput = buildXViewInput({
    externalId: `investigate-now-fuzz-${input.round.toString()}`,
    observedContentText: `Concurrency fuzz payload for ${roundTag}`,
  });
  const callerCount = randomInt(input.random, 4, 14);
  const callerPlans = buildCallerPlans({
    callerMode,
    callerCount,
    random: input.random,
    round: input.round,
  });
  const expectedStoredStatus = expectedStoredStatusForScenario(scenario);

  return {
    roundTag,
    input: viewInput,
    scenario,
    callerMode,
    callerPlans,
    expectedStoredStatus,
    allowedReturnedStatuses: allowedReturnedStatusesForScenario(scenario, expectedStoredStatus),
    requiresPendingRecoveryEvidence: scenario === "PROCESSING_STALE",
    hasUserKeyCaller: hasUserKeyCallerForMode(callerMode),
    seedExistingInvestigation: () =>
      seedExistingInvestigationForScenario({
        scenario,
        viewInput,
        round: input.round,
      }),
    runConcurrentInvestigateNow: () =>
      runConcurrentInvestigateNowWithPlans({
        viewInput,
        callerPlans,
        roundTag,
      }),
  };
}
