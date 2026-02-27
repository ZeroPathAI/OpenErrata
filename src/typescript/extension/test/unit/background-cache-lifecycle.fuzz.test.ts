import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionPageStatus,
  ExtensionPostStatus,
  ExtensionSkippedReason,
  ExtensionSkippedStatus,
  Platform,
} from "@openerrata/shared";
import { extensionPostStatusSchema, extensionSkippedStatusSchema } from "@openerrata/shared";
import { createTabStatusCacheStore } from "../../src/background/cache-store";
import { createDeterministicRandom, randomChance, randomInt } from "../helpers/fuzz-utils";

type ModelRecord = {
  activePostStatus: ExtensionPostStatus | null;
  skippedStatus: ExtensionSkippedStatus | null;
};

function emptyModelRecord(): ModelRecord {
  return {
    activePostStatus: null,
    skippedStatus: null,
  };
}

function expectedStatusFor(model: ModelRecord): ExtensionPageStatus | null {
  if (model.skippedStatus !== null) {
    return model.skippedStatus;
  }
  return model.activePostStatus;
}

function createPostStatus(input: {
  tabSessionId: number;
  platform: Platform;
  externalId: string;
  pageUrl: string;
  investigationState: ExtensionPostStatus["investigationState"];
  investigationId?: string;
}): ExtensionPostStatus {
  const base = {
    kind: "POST",
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
    ...(input.investigationId === undefined ? {} : { investigationId: input.investigationId }),
  } as const;

  if (input.investigationState === "INVESTIGATING") {
    return extensionPostStatusSchema.parse({
      ...base,
      investigationState: "INVESTIGATING",
      status: "PENDING",
      provenance: "CLIENT_FALLBACK",
      claims: null,
      priorInvestigationResult: null,
    });
  }

  if (input.investigationState === "INVESTIGATED") {
    return extensionPostStatusSchema.parse({
      ...base,
      investigationState: "INVESTIGATED",
      provenance: "CLIENT_FALLBACK",
      claims: [],
    });
  }

  if (input.investigationState === "NOT_INVESTIGATED") {
    return extensionPostStatusSchema.parse({
      ...base,
      investigationState: "NOT_INVESTIGATED",
      claims: null,
      priorInvestigationResult: null,
    });
  }

  if (input.investigationState === "FAILED") {
    return extensionPostStatusSchema.parse({
      ...base,
      investigationState: "FAILED",
      provenance: "CLIENT_FALLBACK",
      claims: null,
    });
  }

  return extensionPostStatusSchema.parse({
    ...base,
    investigationState: "CONTENT_MISMATCH",
    claims: null,
  });
}

function createSkippedStatus(input: {
  tabSessionId: number;
  platform: Platform;
  externalId: string;
  pageUrl: string;
  reason: ExtensionSkippedReason;
}): ExtensionSkippedStatus {
  return extensionSkippedStatusSchema.parse({
    kind: "SKIPPED",
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
    reason: input.reason,
  });
}

function matchesActiveStatus(
  activeStatus: ExtensionPostStatus,
  incomingStatus: ExtensionPostStatus,
): boolean {
  if (activeStatus.tabSessionId !== incomingStatus.tabSessionId) {
    return false;
  }

  if (
    activeStatus.platform !== incomingStatus.platform ||
    activeStatus.externalId !== incomingStatus.externalId ||
    activeStatus.pageUrl !== incomingStatus.pageUrl
  ) {
    return false;
  }

  if (activeStatus.investigationId !== undefined && incomingStatus.investigationId !== undefined) {
    return activeStatus.investigationId === incomingStatus.investigationId;
  }

  return true;
}

function statusForBadge(status: ExtensionPageStatus | null): ExtensionPostStatus | null {
  if (status?.kind === "POST") {
    return status;
  }
  return null;
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  const index = randomInt(random, 0, items.length - 1);
  const selected = items[index];
  if (selected === undefined) {
    throw new Error(`Expected an item at index ${index.toString()}`);
  }
  return selected;
}

test("randomized tab-cache lifecycle preserves cache and badge invariants", async () => {
  const random = createDeterministicRandom(0x47c19a2b);
  const knownPlatforms: Platform[] = ["X", "LESSWRONG", "SUBSTACK", "WIKIPEDIA"];
  const knownSkipReasons: ExtensionSkippedReason[] = [
    "word_count",
    "unsupported_content",
    "has_video",
    "no_text",
    "private_or_gated",
  ];

  const persistedStorage = new Map<string, unknown>();
  const openTabs = new Set<number>([1, 2, 3]);
  const badgeByTab = new Map<number, ExtensionPostStatus | null>();
  const warnings: unknown[][] = [];

  const cacheStore = createTabStatusCacheStore({
    browserApi: {
      storage: {
        local: {
          async get(key: string) {
            return {
              [key]: persistedStorage.get(key),
            };
          },
          async set(items: Record<string, unknown>) {
            for (const [key, value] of Object.entries(items)) {
              persistedStorage.set(key, value);
            }
          },
          async remove(key: string) {
            persistedStorage.delete(key);
          },
        },
      },
      tabs: {
        async query() {
          return Array.from(openTabs, (id) => ({ id }));
        },
      },
    },
    updateBadge(tabId, status) {
      badgeByTab.set(tabId, status);
    },
    warn(...args: unknown[]) {
      warnings.push(args);
    },
  });

  const modelByTab = new Map<number, ModelRecord>();

  function modelFor(tabId: number): ModelRecord {
    const existing = modelByTab.get(tabId);
    if (existing) return existing;
    const created = emptyModelRecord();
    modelByTab.set(tabId, created);
    return created;
  }

  const rounds = 12;
  const operationsPerRound = 120;

  for (let round = 0; round < rounds; round += 1) {
    for (let step = 0; step < operationsPerRound; step += 1) {
      const tabId = randomInt(random, 1, 8);
      const model = modelFor(tabId);
      const operation = randomInt(random, 0, 8);

      if (operation === 0) {
        openTabs.add(tabId);
      } else if (operation === 1) {
        openTabs.delete(tabId);
      } else if (operation === 2) {
        const platform = pickRandom(knownPlatforms, random);
        const externalId = `${platform.toLowerCase()}-${round.toString()}-${step.toString()}`;
        const pageUrl = `https://example.test/${platform.toLowerCase()}/${externalId}`;
        const investigationState: ExtensionPostStatus["investigationState"] = randomChance(
          random,
          0.5,
        )
          ? "INVESTIGATING"
          : "INVESTIGATED";
        const postStatus = createPostStatus({
          tabSessionId: randomInt(random, 1, 4),
          platform,
          externalId,
          pageUrl,
          investigationState,
          ...(randomChance(random, 0.4)
            ? { investigationId: `inv-${round.toString()}-${step.toString()}` }
            : {}),
        });

        await cacheStore.cachePostStatus(tabId, postStatus);
        model.activePostStatus = postStatus;
        model.skippedStatus = null;
        assert.deepEqual(badgeByTab.get(tabId), postStatus);
      } else if (operation === 3) {
        const existingActive = model.activePostStatus;
        const platform = existingActive?.platform ?? pickRandom(knownPlatforms, random);
        const externalId =
          existingActive?.externalId ??
          `${platform.toLowerCase()}-candidate-${round.toString()}-${step.toString()}`;
        const pageUrl =
          existingActive?.pageUrl ?? `https://example.test/${platform.toLowerCase()}/${externalId}`;

        const candidate = createPostStatus({
          tabSessionId: randomChance(random, 0.7)
            ? (existingActive?.tabSessionId ?? randomInt(random, 1, 5))
            : randomInt(random, 6, 9),
          platform,
          externalId,
          pageUrl,
          investigationState: randomChance(random, 0.5) ? "INVESTIGATING" : "INVESTIGATED",
          ...(randomChance(random, 0.5) && existingActive?.investigationId !== undefined
            ? { investigationId: existingActive.investigationId }
            : {}),
        });

        const badgeBefore = badgeByTab.get(tabId);
        await cacheStore.cachePostStatus(tabId, candidate, { setActive: false });

        const shouldApply =
          existingActive !== null && matchesActiveStatus(existingActive, candidate);
        if (shouldApply) {
          model.activePostStatus = candidate;
          assert.deepEqual(badgeByTab.get(tabId), candidate);
        } else {
          assert.deepEqual(badgeByTab.get(tabId), badgeBefore);
        }
      } else if (operation === 4) {
        const platform = pickRandom(knownPlatforms, random);
        const externalId = `${platform.toLowerCase()}-skip-${round.toString()}-${step.toString()}`;
        const reason = pickRandom(knownSkipReasons, random);
        const skippedStatus = createSkippedStatus({
          tabSessionId: randomInt(random, 1, 6),
          platform,
          externalId,
          pageUrl: `https://example.test/${platform.toLowerCase()}/${externalId}`,
          reason,
        });

        await cacheStore.cacheSkippedStatus(tabId, skippedStatus);
        model.activePostStatus = null;
        model.skippedStatus = skippedStatus;
        assert.equal(badgeByTab.get(tabId), null);
      } else if (operation === 5) {
        await cacheStore.clearActiveStatus(tabId);
        model.activePostStatus = null;
        model.skippedStatus = null;
        assert.equal(badgeByTab.get(tabId), null);
      } else if (operation === 6) {
        cacheStore.clearCache(tabId);
        model.activePostStatus = null;
        model.skippedStatus = null;
        assert.equal(badgeByTab.get(tabId), null);
      } else if (operation === 7) {
        const observed = await cacheStore.getActiveStatus(tabId);
        assert.deepEqual(observed, expectedStatusFor(model));
      } else {
        await cacheStore.syncToolbarBadgesForOpenTabs();
        for (const openTabId of openTabs) {
          const expected = statusForBadge(expectedStatusFor(modelFor(openTabId)));
          assert.deepEqual(badgeByTab.get(openTabId) ?? null, expected);
        }
      }

      if (step % 15 === 0) {
        const allKnownTabs = new Set<number>([
          ...openTabs,
          ...modelByTab.keys(),
          ...badgeByTab.keys(),
        ]);
        for (const knownTabId of allKnownTabs) {
          const observed = await cacheStore.getActiveStatus(knownTabId);
          assert.deepEqual(observed, expectedStatusFor(modelFor(knownTabId)));
        }
      }
    }
  }

  assert.deepEqual(warnings, []);
});
