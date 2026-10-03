/**
 * A minimal `chrome` global for unit tests of modules that import
 * `webextension-polyfill`. Install it before importing those modules; the
 * polyfill wraps the object it finds at import time, so tests change the
 * returned state rather than replacing the global.
 */

type Callback<T> = ((value: T) => void) | undefined;

function reply<T>(value: T, callback: Callback<T>): Promise<T> | undefined {
  if (typeof callback === "function") {
    callback(value);
    return undefined;
  }
  return Promise.resolve(value);
}

function storageArea(record: Record<string, unknown>) {
  return {
    get: (keys: unknown, callback?: Callback<Record<string, unknown>>) => {
      const wanted =
        keys === null || keys === undefined
          ? Object.keys(record)
          : Array.isArray(keys)
            ? keys.filter((key): key is string => typeof key === "string")
            : typeof keys === "string"
              ? [keys]
              : [];
      const result: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in record) result[key] = record[key];
      }
      return reply(result, callback);
    },
    set: (items: Record<string, unknown>, callback?: Callback<undefined>) => {
      Object.assign(record, items);
      return reply(undefined, callback);
    },
    remove: (keys: unknown, callback?: Callback<undefined>) => {
      const removed = Array.isArray(keys) ? keys : [keys];
      for (const key of removed) {
        if (typeof key === "string") Reflect.deleteProperty(record, key);
      }
      return reply(undefined, callback);
    },
  };
}

export interface ChromeMockState {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  actionCalls: { method: string; details: unknown }[];
  grantedOrigins: Set<string>;
}

export function installChromeMock(options: { version?: string } = {}): ChromeMockState {
  const state: ChromeMockState = {
    local: {},
    session: {},
    actionCalls: [],
    grantedOrigins: new Set(["https://*/*"]),
  };
  const action = (method: string) => (details: unknown, callback?: Callback<undefined>) => {
    state.actionCalls.push({ method, details });
    return reply(undefined, callback);
  };
  const noopEvent = {
    addListener: () => undefined,
    removeListener: () => undefined,
    hasListener: () => false,
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-extension",
      getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
      getManifest: () => ({ manifest_version: 3, version: options.version ?? "0.3.3" }),
      onMessage: noopEvent,
    },
    storage: {
      local: storageArea(state.local),
      session: storageArea(state.session),
      onChanged: noopEvent,
    },
    action: {
      setIcon: action("setIcon"),
      setTitle: action("setTitle"),
      setBadgeText: action("setBadgeText"),
      setBadgeBackgroundColor: action("setBadgeBackgroundColor"),
    },
    permissions: {
      contains: (permissions: { origins?: string[] }, callback?: Callback<boolean>) =>
        reply(
          (permissions.origins ?? []).every(
            (origin) => state.grantedOrigins.has(origin) || origin.startsWith("https://"),
          ),
          callback,
        ),
      request: (permissions: { origins?: string[] }, callback?: Callback<boolean>) => {
        for (const origin of permissions.origins ?? []) state.grantedOrigins.add(origin);
        return reply(true, callback);
      },
    },
  };
  return state;
}
