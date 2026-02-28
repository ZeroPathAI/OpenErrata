import type { ExtensionPostStatus } from "@openerrata/shared";
import browser from "webextension-polyfill";

interface ToolbarBadgeState {
  text: string;
  color?: string;
}

type ToolbarGlobalBadgeOverride =
  | {
      kind: "none";
    }
  | {
      kind: "upgrade_required";
      message: string;
    };

const badgeUpdateQueues = new Map<number, Promise<void>>();
const DEFAULT_ACTION_TITLE = "OpenErrata";
const UPGRADE_REQUIRED_BADGE_COLOR = "#dc2626";
let globalBadgeOverride: ToolbarGlobalBadgeOverride = { kind: "none" };

// ---------------------------------------------------------------------------
// Icon animation — pulses the magnifying glass lens while investigating
// ---------------------------------------------------------------------------

const ANIMATION_FRAME_COUNT = 4;
const ANIMATION_FRAME_INTERVAL_MS = 300;

const iconAnimationTimers = new Map<number, ReturnType<typeof setInterval>>();

function extensionAssetUrl(relativePath: string): string {
  // In extension runtime this resolves from the extension root, avoiding
  // service-worker-relative fetch failures for action icon updates.
  return browser.runtime.getURL(relativePath);
}

function animationFramePaths(frameIndex: number): Record<string, string> {
  return {
    "16": extensionAssetUrl(`icons/frame-${frameIndex.toString()}-16.png`),
    "48": extensionAssetUrl(`icons/frame-${frameIndex.toString()}-48.png`),
  };
}

function staticIconPaths(): Record<string, string> {
  return {
    "16": extensionAssetUrl("icons/icon-16.png"),
    "48": extensionAssetUrl("icons/icon-48.png"),
    "128": extensionAssetUrl("icons/icon-128.png"),
  };
}

function startIconAnimation(tabId: number): void {
  if (iconAnimationTimers.has(tabId)) return;
  let frameIndex = 0;
  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % ANIMATION_FRAME_COUNT;
    browser.action
      .setIcon({ tabId, path: animationFramePaths(frameIndex) })
      .catch((error: unknown) => {
        stopIconAnimation(tabId);
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
 * - UPGRADE_REQUIRED (global): "!" red  — extension version is below server minimum
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
      if (globalBadgeOverride.kind === "none" && status?.investigationState === "INVESTIGATING") {
        const investigatingIconApplied = await browser.action
          .setIcon({ tabId, path: animationFramePaths(0) })
          .then(() => true)
          .catch((error: unknown) => {
            console.warn(`Failed to set investigating icon for tab ${tabId.toString()}:`, error);
            return false;
          });

        if (investigatingIconApplied) {
          startIconAnimation(tabId);
        } else {
          stopIconAnimation(tabId);
          await browser.action.setIcon({ tabId, path: staticIconPaths() }).catch(() => {
            /* noop */
          });
        }
      } else {
        stopIconAnimation(tabId);
        await browser.action.setIcon({ tabId, path: staticIconPaths() }).catch(() => {
          /* noop */
        });
      }

      await browser.action
        .setTitle({
          tabId,
          title:
            globalBadgeOverride.kind === "upgrade_required"
              ? globalBadgeOverride.message
              : DEFAULT_ACTION_TITLE,
        })
        .catch(() => {
          /* noop */
        });

      const badge = toToolbarBadgeState(status, globalBadgeOverride);
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

export function setToolbarUpgradeRequiredState(
  input: { active: true; message: string } | { active: false },
): void {
  if (!input.active) {
    globalBadgeOverride = { kind: "none" };
    return;
  }

  globalBadgeOverride = {
    kind: "upgrade_required",
    message: input.message,
  };
}

function toToolbarBadgeState(
  status: ExtensionPostStatus | null,
  override: ToolbarGlobalBadgeOverride,
): ToolbarBadgeState {
  if (override.kind === "upgrade_required") {
    return {
      text: "!",
      color: UPGRADE_REQUIRED_BADGE_COLOR,
    };
  }

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
