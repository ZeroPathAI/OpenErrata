<script lang="ts">
  import type { SettingsValidationOutput } from "@openerrata/shared";
  import {
    DEFAULT_EXTENSION_SETTINGS,
    ensureApiHostPermission,
    loadExtensionSettings,
    normalizeApiBaseUrl,
    normalizeOpenaiApiKey,
    saveExtensionSettings,
  } from "../lib/settings.js";
  import {
    getOpenaiApiKeyFormatError,
    probeSettingsConfiguration,
  } from "./settings-validation.js";

  const LIVE_VALIDATION_DEBOUNCE_MS = 500;

  type FeedbackTone = "pending" | "success" | "error";
  type Feedback = { tone: FeedbackTone; text: string };

  let apiUrl = $state(DEFAULT_EXTENSION_SETTINGS.apiBaseUrl);
  let instanceApiKey = $state(DEFAULT_EXTENSION_SETTINGS.apiKey);
  let openaiApiKey = $state(DEFAULT_EXTENSION_SETTINGS.openaiApiKey);
  let autoInvestigate = $state(DEFAULT_EXTENSION_SETTINGS.autoInvestigate);
  let hmacSecret = $state(DEFAULT_EXTENSION_SETTINGS.hmacSecret);
  let loaded = $state(false);
  let saved = $state(false);
  let error = $state<string | null>(null);
  let openaiFeedback = $state<Feedback | null>(null);
  let instanceFeedback = $state<Feedback | null>(null);

  let validationRunId = 0;
  let validationTimer: ReturnType<typeof setTimeout> | null = null;

  async function load() {
    const settings = await loadExtensionSettings();
    apiUrl = settings.apiBaseUrl;
    instanceApiKey = settings.apiKey;
    openaiApiKey = settings.openaiApiKey;
    autoInvestigate = settings.autoInvestigate;
    hmacSecret = settings.hmacSecret;
    loaded = true;
  }

  function toOpenaiFeedback(
    validation: SettingsValidationOutput,
  ): Feedback | null {
    switch (validation.openaiApiKeyStatus) {
      case "missing":
        return null;
      case "valid":
        return {
          tone: "success",
          text: "OpenAI API key is valid.",
        };
      case "format_invalid":
        return {
          tone: "error",
          text:
            validation.openaiApiKeyMessage ??
            "OpenAI API key format is invalid.",
        };
      case "invalid":
        return {
          tone: "error",
          text:
            validation.openaiApiKeyMessage ??
            "OpenAI rejected this API key.",
        };
      case "error":
        return {
          tone: "error",
          text:
            validation.openaiApiKeyMessage ??
            "Could not validate OpenAI API key.",
        };
      default: {
        const neverStatus: never = validation.openaiApiKeyStatus;
        throw new Error(
          `Unhandled OpenAI validation status: ${neverStatus}`,
        );
      }
    }
  }

  function toInstanceFeedback(
    apiKey: string,
    validation: SettingsValidationOutput,
  ): Feedback {
    if (apiKey.trim().length === 0) {
      return {
        tone: "success",
        text: "Connected to a compatible OpenErrata API server.",
      };
    }

    if (validation.instanceApiKeyAccepted) {
      return {
        tone: "success",
        text: "Connected to API server. Instance API key is valid.",
      };
    }

    return {
      tone: "error",
      text: "Connected to API server, but the instance API key was rejected.",
    };
  }

  async function validateSettingsLive(
    runId: number,
    input: { apiBaseUrl: string; apiKey: string; openaiApiKey: string },
  ): Promise<void> {
    const probeResult = await probeSettingsConfiguration(input);
    if (runId !== validationRunId) return;

    if (probeResult.status === "error") {
      instanceFeedback = {
        tone: "error",
        text: probeResult.message,
      };

      const openaiFormatError = getOpenaiApiKeyFormatError(input.openaiApiKey);
      const normalizedOpenaiApiKey = normalizeOpenaiApiKey(input.openaiApiKey);
      if (
        openaiFormatError === null &&
        normalizedOpenaiApiKey.length > 0
      ) {
        openaiFeedback = {
          tone: "error",
          text:
            "Could not validate OpenAI API key because API instance validation failed.",
        };
      }

      return;
    }

    instanceFeedback = toInstanceFeedback(input.apiKey, probeResult.validation);
    openaiFeedback = toOpenaiFeedback(probeResult.validation);
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
    const openaiFormatError = getOpenaiApiKeyFormatError(normalizedOpenaiApiKey);
    if (openaiFormatError !== null) {
      error = openaiFormatError;
      return;
    }

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

  $effect(() => {
    if (!loaded) return;

    const currentApiUrl = apiUrl;
    const currentApiKey = instanceApiKey;
    const currentOpenaiApiKey = openaiApiKey;
    const runId = ++validationRunId;

    if (validationTimer !== null) {
      clearTimeout(validationTimer);
      validationTimer = null;
    }

    const openaiFormatError = getOpenaiApiKeyFormatError(currentOpenaiApiKey);
    const normalizedOpenaiApiKey = normalizeOpenaiApiKey(currentOpenaiApiKey);

    if (openaiFormatError !== null) {
      openaiFeedback = {
        tone: "error",
        text: openaiFormatError,
      };
    } else if (normalizedOpenaiApiKey.length > 0) {
      openaiFeedback = {
        tone: "pending",
        text: "Validating OpenAI API key...",
      };
    } else {
      openaiFeedback = null;
    }

    const normalizedApiUrl = normalizeApiBaseUrl(currentApiUrl);
    if (!normalizedApiUrl) {
      instanceFeedback = {
        tone: "error",
        text: "API Server URL must be a valid http(s) URL.",
      };
      if (openaiFormatError === null && normalizedOpenaiApiKey.length > 0) {
        openaiFeedback = {
          tone: "error",
          text:
            "Cannot validate OpenAI API key until API Server URL is valid.",
        };
      }
      return;
    }

    instanceFeedback = {
      tone: "pending",
      text: "Checking API server and credentials...",
    };

    validationTimer = setTimeout(() => {
      void validateSettingsLive(runId, {
        apiBaseUrl: currentApiUrl,
        apiKey: currentApiKey,
        openaiApiKey: currentOpenaiApiKey,
      }).catch(() => {
        if (runId !== validationRunId) return;
        instanceFeedback = {
          tone: "error",
          text: "Unexpected error while validating settings.",
        };
      });
    }, LIVE_VALIDATION_DEBOUNCE_MS);

    return () => {
      if (validationTimer !== null) {
        clearTimeout(validationTimer);
        validationTimer = null;
      }
    };
  });
</script>

<h1>OpenErrata Settings</h1>

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
    <p class="hint">Used only per request. The API does not store this key beyond request lifecycles.</p>
    {#if openaiFeedback}
      <p class={`validation ${openaiFeedback.tone}`} aria-live="polite">
        {openaiFeedback.text}
      </p>
    {/if}
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
      placeholder="https://api.openerrata.com"
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

  {#if instanceFeedback}
    <p class={`validation ${instanceFeedback.tone}`} aria-live="polite">
      {instanceFeedback.text}
    </p>
  {/if}
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

  .validation {
    margin: 6px 0 0;
    font-size: 12px;
  }

  .validation.pending {
    color: #2563eb;
  }

  .validation.success {
    color: #15803d;
  }

  .validation.error {
    color: #dc2626;
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
