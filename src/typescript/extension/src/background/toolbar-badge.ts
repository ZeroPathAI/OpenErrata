import type { ExtensionPostStatus } from "@openerrata/shared";
import browser from "webextension-polyfill";

type ToolbarBadgeState = {
  text: string;
  color?: string;
};

const badgeUpdateQueues = new Map<number, Promise<void>>();

// ---------------------------------------------------------------------------
// Icon animation — pulses the magnifying glass lens while investigating
// ---------------------------------------------------------------------------

const ANIMATION_FRAME_COUNT = 4;
const ANIMATION_FRAME_INTERVAL_MS = 300;

const iconAnimationTimers = new Map<number, ReturnType<typeof setInterval>>();

function animationFramePaths(frameIndex: number): Record<string, string> {
  return {
    "16": `icons/frame-${frameIndex.toString()}-16.png`,
    "48": `icons/frame-${frameIndex.toString()}-48.png`,
  };
}

const STATIC_ICON_PATHS: Record<string, string> = {
  "16": "icons/icon-16.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

function startIconAnimation(tabId: number): void {
  if (iconAnimationTimers.has(tabId)) return;
  let frameIndex = 0;
  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % ANIMATION_FRAME_COUNT;
    browser.action
      .setIcon({ tabId, path: animationFramePaths(frameIndex) })
      .catch((error: unknown) => {
        console.warn(`Icon animation frame failed for tab ${tabId.toString()}:`, error);
      });
  }, ANIMATION_FRAME_INTERVAL_MS);
  iconAnimationTimers.set(tabId, timer);
}

function stopIconAnimation(tabId: number): void {
  const timer = iconAnimationTimers.get(tabId);
  if (timer !== undefined) {
    clearInterval(timer);
    iconAnimationTimers.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Updates the Chrome toolbar icon and badge for a tab based on investigation
 * status.
 *
 * Icon states:
 * - INVESTIGATING:             pulsing magnifying glass lens
 * - anything else:             static icon
 *
 * Badge states:
 * - INVESTIGATING:          "…" blue    — investigation in progress
 * - INVESTIGATED + claims:  "N" red     — N claims found
 * - INVESTIGATED + 0 claims: "✓" green  — clean, no claims
 * - FAILED:                 "!" red     — investigation failed
 * - CONTENT_MISMATCH:       "!" amber   — client page differs from canonical post content
 * - NOT_INVESTIGATED / null: ""         — no badge
 */
export function updateToolbarBadge(tabId: number, status: ExtensionPostStatus | null): void {
  const previousUpdate = badgeUpdateQueues.get(tabId) ?? Promise.resolve();
  const nextUpdate = previousUpdate
    .catch(() => {
      // Prior failures should not block future badge updates for this tab.
    })
    .then(async () => {
      // Icon animation is best-effort — it must never prevent the badge from
      // being set, so errors are caught independently.
      if (status?.investigationState === "INVESTIGATING") {
        await browser.action.setIcon({ tabId, path: animationFramePaths(0) }).catch(() => {});
        startIconAnimation(tabId);
      } else {
        stopIconAnimation(tabId);
        await browser.action.setIcon({ tabId, path: STATIC_ICON_PATHS }).catch(() => {});
      }

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
    .catch((error: unknown) => {
      console.warn(`toolbar badge update failed for tab ${tabId.toString()}:`, error);
    })
    .finally(() => {
      if (badgeUpdateQueues.get(tabId) === nextUpdate) {
        badgeUpdateQueues.delete(tabId);
      }
    });

  badgeUpdateQueues.set(tabId, nextUpdate);
}

function toToolbarBadgeState(status: ExtensionPostStatus | null): ToolbarBadgeState {
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

  if (status.investigationState === "CONTENT_MISMATCH") {
    return {
      text: "!",
      color: "#f59e0b",
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
