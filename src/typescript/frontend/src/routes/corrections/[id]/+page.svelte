<script lang="ts">
  import type { PageData } from "./$types";
  import type { PublicInvestigationResult } from "./+page.server";

  const { data }: { data: PageData } = $props();

  const result: PublicInvestigationResult | null = $derived(data.result);

  const platformLabels: Record<string, string> = {
    LESSWRONG: "LessWrong",
    X: "X",
    SUBSTACK: "Substack",
    WIKIPEDIA: "Wikipedia",
  };

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function truncateUrl(url: string, maxLength: number = 80): string {
    const withoutProtocol = url.replace(/^https?:\/\//, "");
    if (withoutProtocol.length <= maxLength) {
      return withoutProtocol;
    }
    return withoutProtocol.substring(0, maxLength) + "...";
  }
</script>

<svelte:head>
  {#if result}
    <title>Corrections for {truncateUrl(result.post.url, 40)} - OpenErrata</title>
    <meta
      name="description"
      content="OpenErrata found {result.claims.length} correction{result.claims.length !== 1
        ? 's'
        : ''} for this {platformLabels[result.post.platform]} post."
    />
  {:else}
    <title>Investigation Not Found - OpenErrata</title>
  {/if}
</svelte:head>

<div class="page">
  <main class="content">
    <div class="content-inner">
      <a href="/corrections" class="back-link">All corrections</a>

      {#if data.error}
        <div class="error-state">
          <p>Failed to load investigation. The API may be unavailable.</p>
          <p class="error-detail">{data.error}</p>
        </div>
      {:else if !result}
        <div class="empty-state">
          <h1>Investigation not found</h1>
          <p>This investigation doesn't exist or hasn't completed yet.</p>
          <a href="/corrections" class="btn btn-secondary">Browse corrections</a>
        </div>
      {:else}
        <div class="investigation-header">
          <div class="header-meta">
            <span class="platform-badge platform-{result.post.platform.toLowerCase()}">
              {platformLabels[result.post.platform]}
            </span>
            <span class="date">
              {formatDate(result.investigation.checkedAt)} at {formatTime(
                result.investigation.checkedAt,
              )}
            </span>
          </div>
          <h1 class="post-url">
            <a href={result.post.url} target="_blank" rel="noopener noreferrer">
              {truncateUrl(result.post.url)}
              <svg
                class="external-icon"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path d="M6 3h7v7M13 3L6 10" />
              </svg>
            </a>
          </h1>
          <p class="correction-summary">
            {#if result.claims.length === 0}
              No corrections found. This post passed fact-checking with no issues.
            {:else}
              {result.claims.length} correction{result.claims.length !== 1 ? "s" : ""} found
            {/if}
          </p>
        </div>

        {#if result.claims.length > 0}
          <div class="claims">
            {#each result.claims as claim, i (claim.id)}
              <div class="claim-card">
                <div class="claim-number">{i + 1}</div>
                <div class="claim-content">
                  <div class="claim-quote">
                    <span class="quote-label">Claim</span>
                    <blockquote>{claim.text}</blockquote>
                  </div>

                  <div class="claim-correction">
                    <span class="correction-label">Correction</span>
                    <p>{claim.summary}</p>
                  </div>

                  <details class="claim-details">
                    <summary>Full reasoning</summary>
                    <div class="reasoning">{claim.reasoning}</div>
                  </details>

                  {#if claim.sources.length > 0}
                    <details class="claim-details">
                      <summary
                        >{claim.sources.length} source{claim.sources.length !== 1
                          ? "s"
                          : ""}</summary
                      >
                      <ul class="sources-list">
                        {#each claim.sources as source (source.url)}
                          <li class="source-item">
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="source-title">{source.title}</a
                            >
                            <p class="source-snippet">{source.snippet}</p>
                          </li>
                        {/each}
                      </ul>
                    </details>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <div class="investigation-meta">
          <span>Model: {result.investigation.model}</span>
          <span>Prompt: {result.investigation.promptVersion}</span>
        </div>
      {/if}
    </div>
  </main>

  <footer class="footer">
    <div class="content-inner footer-inner">
      <span class="footer-logo">OpenErrata</span>
      <div class="footer-links">
        <a href="https://github.com/ZeroPathAI/openerrata" target="_blank" rel="noopener noreferrer"
          >GitHub</a
        >
        <a
          href="https://github.com/ZeroPathAI/openerrata/blob/main/SPEC.md"
          target="_blank"
          rel="noopener noreferrer">Spec</a
        >
      </div>
    </div>
  </footer>
</div>

<style>
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .content {
    flex: 1;
    padding: 2rem 1.5rem;
  }

  .content-inner {
    max-width: var(--max-width);
    margin: 0 auto;
  }

  /* Back link */
  .back-link {
    display: inline-flex;
    align-items: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin-bottom: 2rem;
  }

  .back-link::before {
    content: "\2190";
    margin-right: 0.5rem;
  }

  .back-link:hover {
    color: var(--color-text);
    text-decoration: none;
  }

  /* Header */
  .investigation-header {
    margin-bottom: 2.5rem;
  }

  .header-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .platform-badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    background: var(--color-border);
    color: var(--color-text-muted);
  }

  .date {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .post-url {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    word-break: break-all;
  }

  .post-url a {
    color: var(--color-text);
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
  }

  .post-url a:hover {
    color: var(--color-accent);
    text-decoration: none;
  }

  .external-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .correction-summary {
    font-size: 1rem;
    color: var(--color-text-muted);
  }

  /* Claims */
  .claims {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    margin-bottom: 2.5rem;
  }

  .claim-card {
    display: flex;
    gap: 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .claim-number {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: var(--color-error);
    color: #fff;
    font-weight: 700;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .claim-content {
    flex: 1;
    min-width: 0;
  }

  /* Quote */
  .claim-quote {
    margin-bottom: 1rem;
  }

  .quote-label,
  .correction-label {
    display: block;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
    margin-bottom: 0.375rem;
  }

  blockquote {
    font-size: 0.9375rem;
    line-height: 1.6;
    color: var(--color-text);
    border-left: 3px solid var(--color-error);
    padding-left: 1rem;
    font-style: italic;
  }

  /* Correction */
  .claim-correction {
    margin-bottom: 1rem;
  }

  .claim-correction p {
    font-size: 0.9375rem;
    line-height: 1.6;
    color: var(--color-text);
  }

  /* Details/Reasoning */
  .claim-details {
    margin-bottom: 0.75rem;
  }

  .claim-details summary {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 0.375rem 0;
  }

  .claim-details summary:hover {
    color: var(--color-text);
  }

  .reasoning {
    font-size: 0.875rem;
    line-height: 1.7;
    color: var(--color-text-muted);
    margin-top: 0.5rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--color-border);
    white-space: pre-wrap;
  }

  /* Sources */
  .sources-list {
    list-style: none;
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .source-item {
    padding: 0.75rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .source-title {
    font-size: 0.8125rem;
    font-weight: 600;
    display: block;
    margin-bottom: 0.25rem;
  }

  .source-snippet {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    line-height: 1.5;
  }

  /* Investigation meta */
  .investigation-meta {
    display: flex;
    gap: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
    margin-bottom: 2rem;
  }

  .investigation-meta span {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  /* Error / empty */
  .error-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-muted);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }

  .error-detail {
    font-size: 0.8125rem;
    color: var(--color-error);
    margin-top: 0.5rem;
    font-family: monospace;
  }

  .empty-state {
    text-align: center;
    padding: 4rem 1rem;
  }

  .empty-state h1 {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }

  .empty-state p {
    color: var(--color-text-muted);
    margin-bottom: 1.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.625rem 1.25rem;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  .btn:hover {
    text-decoration: none;
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover {
    border-color: var(--color-text-muted);
  }

  /* Footer */
  .footer {
    margin-top: auto;
    border-top: 1px solid var(--color-border);
    padding: 1.5rem;
  }

  .footer-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .footer-logo {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .footer-links {
    display: flex;
    gap: 1.25rem;
  }

  .footer-links a {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
  }

  @media (max-width: 640px) {
    .claim-card {
      flex-direction: column;
    }

    .investigation-meta {
      flex-direction: column;
      gap: 0.5rem;
    }

    .footer-inner {
      flex-direction: column;
      gap: 0.75rem;
    }
  }
</style>
