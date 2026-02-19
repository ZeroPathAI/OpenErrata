<script lang="ts">
  import {
    DEFAULT_EXTENSION_SETTINGS,
    ensureApiHostPermission,
    loadExtensionSettings,
    normalizeApiBaseUrl,
    normalizeOpenaiApiKey,
    saveExtensionSettings,
  } from "../lib/settings.js";

  let apiUrl = $state(DEFAULT_EXTENSION_SETTINGS.apiBaseUrl);
  let instanceApiKey = $state(DEFAULT_EXTENSION_SETTINGS.apiKey);
  let openaiApiKey = $state(DEFAULT_EXTENSION_SETTINGS.openaiApiKey);
  let autoInvestigate = $state(DEFAULT_EXTENSION_SETTINGS.autoInvestigate);
  let hmacSecret = $state(DEFAULT_EXTENSION_SETTINGS.hmacSecret);
  let saved = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    const settings = await loadExtensionSettings();
    apiUrl = settings.apiBaseUrl;
    instanceApiKey = settings.apiKey;
    openaiApiKey = settings.openaiApiKey;
    autoInvestigate = settings.autoInvestigate;
    hmacSecret = settings.hmacSecret;
  }

  async function save() {
    error = null;

    const normalizedApiUrl = normalizeApiBaseUrl(apiUrl);
    if (!normalizedApiUrl) {
      error = "API Server URL must be a valid http(s) URL.";
      return;
    }

    const hostPermissionGranted = await ensureApiHostPermission(normalizedApiUrl);
    if (!hostPermissionGranted) {
      error = `Missing permission for ${new URL(normalizedApiUrl).origin}.`;
      return;
    }

    const normalizedOpenaiApiKey = normalizeOpenaiApiKey(openaiApiKey);

    await saveExtensionSettings({
      apiBaseUrl: normalizedApiUrl,
      apiKey: instanceApiKey,
      openaiApiKey: normalizedOpenaiApiKey,
      autoInvestigate,
      hmacSecret,
    });
    apiUrl = normalizedApiUrl;
    openaiApiKey = normalizedOpenaiApiKey;
    saved = true;
    setTimeout(() => { saved = false; }, 2000);
  }

  $effect(() => {
    void load().catch(() => {
      error = "Could not load extension settings.";
    });
  });
</script>

<h1>TrueSight Settings</h1>

<section class="section">
  <h2>Basic</h2>

  <div class="field">
    <label for="openai-key">OpenAI API Key</label>
    <input
      id="openai-key"
      type="password"
      bind:value={openaiApiKey}
      placeholder="sk-..."
      autocomplete="off"
    />
    <p class="hint">Used only per request. The API does not store this key.</p>
  </div>

  <label class="checkbox">
    <input type="checkbox" bind:checked={autoInvestigate} />
    <span>Auto-investigate when a viewed post is not yet investigated</span>
  </label>
</section>

<details class="section advanced">
  <summary>Advanced</summary>

  <div class="field">
    <label for="api-url">API Server URL</label>
    <input
      id="api-url"
      type="url"
      bind:value={apiUrl}
      placeholder="https://api.truesight.dev"
    />
  </div>

  <div class="field">
    <label for="hmac-secret">HMAC Secret</label>
    <input
      id="hmac-secret"
      type="password"
      bind:value={hmacSecret}
      placeholder="Optional override; blank uses bundled default"
      autocomplete="off"
    />
  </div>

  <div class="field">
    <label for="instance-api-key">Instance API Key</label>
    <input
      id="instance-api-key"
      type="password"
      bind:value={instanceApiKey}
      placeholder="ts_live_..."
      autocomplete="off"
    />
  </div>
</details>

<button onclick={save}>Save</button>
{#if saved}
  <span class="saved">Saved!</span>
{/if}
{#if error}
  <p class="error">{error}</p>
{/if}

<style>
  .section {
    margin: 16px 0;
    padding: 14px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #ffffff;
  }

  .section h2 {
    margin: 0 0 10px;
    font-size: 16px;
  }

  .advanced summary {
    cursor: pointer;
    font-weight: 600;
  }

  .field {
    margin: 12px 0;
  }

  label {
    display: block;
    margin-bottom: 4px;
    font-weight: 500;
    font-size: 14px;
  }

  input {
    width: 100%;
    padding: 8px;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 14px;
    box-sizing: border-box;
  }

  .hint {
    margin: 6px 0 0;
    color: #4b5563;
    font-size: 12px;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 400;
  }

  .checkbox input[type="checkbox"] {
    width: auto;
  }

  button {
    padding: 8px 20px;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }
  button:hover {
    background: #1d4ed8;
  }

  .saved {
    margin-left: 12px;
    color: #16a34a;
    font-size: 14px;
  }

  .error {
    margin-top: 12px;
    color: #dc2626;
    font-size: 14px;
  }
</style>
