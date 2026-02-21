import type { ExtensionPostStatus } from "@truesight/shared";
import browser from "webextension-polyfill";

type ToolbarBadgeState = {
  text: string;
  color?: string;
};

const badgeUpdateQueues = new Map<number, Promise<void>>();

/**
 * Updates the Chrome toolbar badge for a tab based on investigation status.
 *
 * Badge states:
 * - INVESTIGATING:          "…" blue    — investigation in progress
 * - INVESTIGATED + claims:  "N" red     — N claims found
 * - INVESTIGATED + 0 claims: "✓" green  — clean, no claims
 * - FAILED:                 "!" red     — investigation failed
 * - NOT_INVESTIGATED / null: ""         — no badge
 */
export function updateToolbarBadge(
  tabId: number,
  status: ExtensionPostStatus | null,
): void {
  const previousUpdate = badgeUpdateQueues.get(tabId) ?? Promise.resolve();
  const nextUpdate = previousUpdate
    .catch(() => {
      // Prior failures should not block future badge updates for this tab.
    })
    .then(async () => {
      const badge = toToolbarBadgeState(status);
      if (badge.text.length === 0) {
        await browser.action.setBadgeText({ tabId, text: "" });
        return;
      }

      // Set color before text so the badge renders with the correct background
      // from the first paint.
      await browser.action.setBadgeBackgroundColor({
        tabId,
        color: badge.color ?? "#000000",
      });
      await browser.action.setBadgeText({ tabId, text: badge.text });
    })
    .catch((error) => {
      console.warn(`toolbar badge update failed for tab ${tabId.toString()}:`, error);
    })
    .finally(() => {
      if (badgeUpdateQueues.get(tabId) === nextUpdate) {
        badgeUpdateQueues.delete(tabId);
      }
    });

  badgeUpdateQueues.set(tabId, nextUpdate);
}

function toToolbarBadgeState(
  status: ExtensionPostStatus | null,
): ToolbarBadgeState {
  if (!status || status.investigationState === "NOT_INVESTIGATED") {
    return { text: "" };
  }

  if (status.investigationState === "INVESTIGATING") {
    return {
      text: "…",
      color: "#3b82f6",
    };
  }

  if (status.investigationState === "FAILED") {
    return {
      text: "!",
      color: "#ef4444",
    };
  }

  if (status.claims.length > 0) {
    return {
      text: status.claims.length.toString(),
      color: "#ef4444",
    };
  }

  return {
    text: "✓",
    color: "#22c55e",
  };
}
