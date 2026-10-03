<script lang="ts">
  import { page } from "$app/state";

  const heading = $derived(page.status === 404 ? "Not found" : "Something went wrong");
</script>

<svelte:head>
  <title>{heading} - OpenErrata</title>
</svelte:head>

<main class="error-page">
  <p class="status">{page.status}</p>
  <h1>{heading}</h1>
  {#if page.error}
    <p class="message">{page.error.message}</p>
  {/if}
  <a href="/corrections" class="btn">Browse corrections</a>
</main>

<style>
  .error-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 6rem 1.5rem;
    text-align: center;
  }

  .status {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-bottom: 0.5rem;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin-bottom: 0.75rem;
  }

  .message {
    color: var(--color-text-muted);
    line-height: 1.6;
    margin-bottom: 2rem;
  }

  .btn {
    display: inline-flex;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.625rem 1.25rem;
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn:hover {
    border-color: var(--color-text-muted);
    text-decoration: none;
  }
</style>
