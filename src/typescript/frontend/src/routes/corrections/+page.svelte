<script lang="ts">
  import type { PageData } from "./$types";
  import type { InvestigationSummary } from "./+page.server";

  const { data }: { data: PageData } = $props();

  const platformLabels: Record<InvestigationSummary["platform"], string> = {
    LESSWRONG: "LessWrong",
    X: "X",
    SUBSTACK: "Substack",
    WIKIPEDIA: "Wikipedia",
  };

  const platforms = [
    { value: "", label: "All platforms" },
    { value: "LESSWRONG", label: "LessWrong" },
    { value: "X", label: "X" },
    { value: "SUBSTACK", label: "Substack" },
    { value: "WIKIPEDIA", label: "Wikipedia" },
  ];

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function truncateUrl(url: string, maxLength: number = 60): string {
    const withoutProtocol = url.replace(/^https?:\/\//, "");
    if (withoutProtocol.length <= maxLength) {
      return withoutProtocol;
    }
    return withoutProtocol.substring(0, maxLength) + "...";
  }
</script>

<svelte:head>
  <title>Latest Corrections - OpenErrata</title>
  <meta
    name="description"
    content="Browse the latest fact-check corrections from OpenErrata. Search by URL or filter by platform."
  />
</svelte:head>

<div class="page">
  <main class="content">
    <div class="content-inner">
      <h1>Latest Corrections</h1>

      <form class="search-bar" method="get" action="/corrections">
        <div class="search-inputs">
          <input
            type="text"
            name="q"
            placeholder="Search by URL or content..."
            value={data.query ?? ""}
            class="search-input"
          />
          <select name="platform" class="platform-select">
            {#each platforms as p (p.value)}
              <option
                value={p.value}
                selected={data.platform === p.value ||
                  (data.platform === undefined && p.value === "")}
              >
                {p.label}
              </option>
            {/each}
          </select>
          <button type="submit" class="btn btn-primary">Search</button>
        </div>
      </form>

      {#if data.error}
        <div class="error-state">
          <p>Failed to load corrections. The API may be unavailable.</p>
          <p class="error-detail">{data.error}</p>
        </div>
      {:else if data.investigations.length === 0}
        <div class="empty-state">
          <p>No corrections found{data.query ? ` matching "${data.query}"` : ""}.</p>
        </div>
      {:else}
        <div class="results">
          {#each data.investigations as investigation (investigation.id)}
            <a href="/corrections/{investigation.id}" class="investigation-card">
              <div class="card-header">
                <span class="platform-badge platform-{investigation.platform.toLowerCase()}">
                  {platformLabels[investigation.platform]}
                </span>
                <span class="date">
                  {formatDate(investigation.checkedAt)} at {formatTime(investigation.checkedAt)}
                </span>
              </div>
              <div class="card-url">{truncateUrl(investigation.url)}</div>
              {#if investigation.claimSummaries.length > 0}
                <ul class="claim-summaries">
                  {#each investigation.claimSummaries as claim (claim.id)}
                    <li>{claim.summary}</li>
                  {/each}
                </ul>
              {/if}
              <div class="card-footer">
                <span class="claim-count" class:has-claims={investigation.claimCount > 0}>
                  {investigation.claimCount} correction{investigation.claimCount !== 1 ? "s" : ""}
                </span>
                <span class="view-arrow">&rarr;</span>
              </div>
            </a>
          {/each}
        </div>

        <div class="pagination">
          {#if data.page > 1}
            <a
              href="/corrections?{new URLSearchParams({
                ...(data.query ? { q: data.query } : {}),
                ...(data.platform ? { platform: data.platform } : {}),
                page: String(data.page - 1),
              }).toString()}"
              class="btn btn-secondary btn-sm"
            >
              Previous
            </a>
          {/if}
          <span class="page-info">Page {data.page}</span>
          {#if data.hasMore}
            <a
              href="/corrections?{new URLSearchParams({
                ...(data.query ? { q: data.query } : {}),
                ...(data.platform ? { platform: data.platform } : {}),
                page: String(data.page + 1),
              }).toString()}"
              class="btn btn-secondary btn-sm"
            >
              Next
            </a>
          {/if}
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

  /* Content */
  .content {
    flex: 1;
    padding: 2rem 1.5rem;
  }

  .content-inner {
    max-width: var(--max-width);
    margin: 0 auto;
  }

  h1 {
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin-bottom: 0.5rem;
  }

  .subtitle {
    color: var(--color-text-muted);
    font-size: 1rem;
    line-height: 1.5;
    margin-bottom: 2rem;
  }

  /* Search */
  .search-bar {
    margin-bottom: 2rem;
  }

  .search-inputs {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .search-input {
    flex: 1;
    min-width: 200px;
    padding: 0.625rem 0.875rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }

  .search-input::placeholder {
    color: var(--color-text-muted);
  }

  .search-input:focus {
    border-color: var(--color-accent);
  }

  .platform-select {
    padding: 0.625rem 0.875rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-family: inherit;
    outline: none;
    cursor: pointer;
  }

  .platform-select:focus {
    border-color: var(--color-accent);
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

  .btn-primary {
    background: var(--color-accent);
    color: #000;
  }

  .btn-primary:hover {
    background: var(--color-accent-muted);
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover {
    border-color: var(--color-text-muted);
  }

  .btn-sm {
    font-size: 0.8125rem;
    padding: 0.375rem 0.875rem;
  }

  /* Results */
  .results {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .investigation-card {
    display: block;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-error);
    border-radius: 12px;
    padding: 1rem 1.25rem;
    text-decoration: none;
    color: var(--color-text);
    transition:
      border-color 0.15s,
      background 0.15s,
      transform 0.1s;
  }

  .investigation-card:hover {
    border-color: var(--color-text-muted);
    border-left-color: var(--color-error);
    background: var(--color-surface-hover);
    text-decoration: none;
    transform: translateX(2px);
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
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
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .card-url {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin-bottom: 0.5rem;
    word-break: break-all;
  }

  .claim-summaries {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.75rem;
  }

  .claim-summaries li {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--color-text-muted);
    padding-left: 0.75rem;
    border-left: 2px solid var(--color-error);
  }

  .card-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .view-arrow {
    margin-left: auto;
    font-size: 1rem;
    color: var(--color-text-muted);
    transition: transform 0.15s;
  }

  .investigation-card:hover .view-arrow {
    transform: translateX(4px);
    color: var(--color-text);
  }

  .claim-count {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .claim-count.has-claims {
    color: var(--color-error);
    font-weight: 600;
  }

  /* Error state */
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

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 4rem 1rem;
    color: var(--color-text-muted);
  }

  /* Pagination */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 2rem;
    padding-bottom: 2rem;
  }

  .page-info {
    font-size: 0.875rem;
    color: var(--color-text-muted);
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
    .search-inputs {
      flex-direction: column;
    }

    .search-input {
      min-width: 0;
    }

    .card-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .footer-inner {
      flex-direction: column;
      gap: 0.75rem;
    }
  }
</style>
