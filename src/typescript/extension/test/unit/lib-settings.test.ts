import assert from "node:assert/strict";
import { test } from "node:test";

type SettingsModule = typeof import("../../src/lib/settings");

interface SettingsChromeMocks {
  getCalls: unknown[];
  setCalls: unknown[];
  containsCalls: unknown[];
  requestCalls: unknown[];
}

const settingsChromeState: {
  stored: Record<string, unknown>;
  containsResult: boolean;
  requestResult: boolean;
  getCalls: unknown[];
  setCalls: unknown[];
  containsCalls: unknown[];
  requestCalls: unknown[];
} = {
  stored: {},
  containsResult: false,
  requestResult: false,
  getCalls: [],
  setCalls: [],
  containsCalls: [],
  requestCalls: [],
};

const settingsChromeMock = {
  runtime: {
    id: "test-extension",
    getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
  },
  storage: {
    local: {
      get: (keys: unknown, callback?: (value: Record<string, unknown>) => void) => {
        settingsChromeState.getCalls.push(keys);
        if (typeof callback === "function") {
          callback(settingsChromeState.stored);
          return;
        }
        return Promise.resolve(settingsChromeState.stored);
      },
      set: (items: unknown, callback?: () => void) => {
        settingsChromeState.setCalls.push(items);
        if (typeof callback === "function") {
          callback();
          return;
        }
        return Promise.resolve();
      },
      remove: (_key: unknown, callback?: () => void) => {
        if (typeof callback === "function") {
          callback();
          return;
        }
        return Promise.resolve();
      },
    },
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
  permissions: {
    contains: (permissions: unknown, callback?: (value: boolean) => void) => {
      settingsChromeState.containsCalls.push(permissions);
      if (typeof callback === "function") {
        callback(settingsChromeState.containsResult);
        return;
      }
      return Promise.resolve(settingsChromeState.containsResult);
    },
    request: (permissions: unknown, callback?: (value: boolean) => void) => {
      settingsChromeState.requestCalls.push(permissions);
      if (typeof callback === "function") {
        callback(settingsChromeState.requestResult);
        return;
      }
      return Promise.resolve(settingsChromeState.requestResult);
    },
  },
};

(globalThis as { chrome?: unknown }).chrome = settingsChromeMock;

function installSettingsChromeMock(input: {
  stored?: Record<string, unknown>;
  containsResult?: boolean;
  requestResult?: boolean;
}): SettingsChromeMocks {
  settingsChromeState.stored = input.stored ?? {};
  settingsChromeState.containsResult = input.containsResult ?? false;
  settingsChromeState.requestResult = input.requestResult ?? false;
  settingsChromeState.getCalls.length = 0;
  settingsChromeState.setCalls.length = 0;
  settingsChromeState.containsCalls.length = 0;
  settingsChromeState.requestCalls.length = 0;

  return {
    getCalls: settingsChromeState.getCalls,
    setCalls: settingsChromeState.setCalls,
    containsCalls: settingsChromeState.containsCalls,
    requestCalls: settingsChromeState.requestCalls,
  };
}

async function importSettingsModule(): Promise<SettingsModule> {
  return (await import(
    `../../src/lib/settings.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as SettingsModule;
}

test("loadExtensionSettings reads local storage and normalizes values", async () => {
  const mocks = installSettingsChromeMock({
    stored: {
      apiBaseUrl: " https://api.openerrata.example/ ",
      apiKey: "  api-key  ",
      openaiApiKey: "  sk-key  ",
      autoInvestigate: true,
    },
  });
  const { loadExtensionSettings } = await importSettingsModule();

  assert.deepEqual(await loadExtensionSettings(), {
    kind: "VALID",
    settings: {
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "api-key",
      openaiApiKey: "sk-key",
      autoInvestigate: true,
    },
  });
  assert.equal(mocks.getCalls.length, 1);
});

test("the options form shows an invalid stored API URL as stored, so it can be fixed", async () => {
  installSettingsChromeMock({ stored: { apiBaseUrl: "http://selfhosted.example.com" } });
  const { loadExtensionSettings, loadSettingsFormValues } = await importSettingsModule();

  assert.equal((await loadExtensionSettings()).kind, "INVALID");
  assert.equal((await loadSettingsFormValues()).apiBaseUrl, "http://selfhosted.example.com");
});

test("saveExtensionSettings persists normalized settings payload", async () => {
  const mocks = installSettingsChromeMock({});
  const { saveExtensionSettings } = await importSettingsModule();

  await saveExtensionSettings({
    apiBaseUrl: " https://api.openerrata.example/ ",
    apiKey: "  api-key  ",
    openaiApiKey: "  sk-key  ",
    autoInvestigate: true,
  });

  assert.deepEqual(mocks.setCalls, [
    {
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "api-key",
      openaiApiKey: "sk-key",
      autoInvestigate: true,
    },
  ]);
});

test("saveExtensionSettings refuses settings that would not load", async () => {
  const mocks = installSettingsChromeMock({});
  const { saveExtensionSettings } = await importSettingsModule();

  await assert.rejects(
    saveExtensionSettings({
      apiBaseUrl: "http://public.example.com",
      apiKey: "",
      openaiApiKey: "",
      autoInvestigate: false,
    }),
    /API Server URL/,
  );
  assert.deepEqual(mocks.setCalls, []);
});

test("ensureApiHostPermission returns true without requesting when permission already exists", async () => {
  const mocks = installSettingsChromeMock({ containsResult: true });
  const { ensureApiHostPermission } = await importSettingsModule();

  const result = await ensureApiHostPermission("https://api.openerrata.example");

  assert.equal(result, true);
  assert.deepEqual(mocks.containsCalls, [
    {
      origins: ["https://api.openerrata.example/*"],
    },
  ]);
  assert.equal(mocks.requestCalls.length, 0);
});

test("ensureApiHostPermission requests permission when not already granted", async () => {
  const mocks = installSettingsChromeMock({ containsResult: false, requestResult: true });
  const { ensureApiHostPermission } = await importSettingsModule();

  const result = await ensureApiHostPermission("https://api.openerrata.example");

  assert.equal(result, true);
  assert.deepEqual(mocks.containsCalls, [
    {
      origins: ["https://api.openerrata.example/*"],
    },
  ]);
  assert.deepEqual(mocks.requestCalls, [
    {
      origins: ["https://api.openerrata.example/*"],
    },
  ]);
});
