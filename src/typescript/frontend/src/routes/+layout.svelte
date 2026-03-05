<script>
  import "../app.css";
  const { children } = $props();
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="logo">OpenErrata</a>
    <div class="nav-links">
      <a href="/corrections">Corrections</a>
      <a href="https://github.com/ZeroPathAI/openerrata" target="_blank" rel="noopener noreferrer"
        >GitHub</a
      >
      <a
        href="https://chromewebstore.google.com/detail/openerrata/TODO"
        target="_blank"
        rel="noopener noreferrer"
        class="btn btn-primary btn-sm">Install Extension</a
      >
    </div>
  </div>
</nav>

{@render children()}

<style>
  .nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(10, 10, 10, 0.8);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--color-border);
  }

  .nav-inner {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 0.75rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .logo {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--color-text);
    text-decoration: none;
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .nav-links a {
    color: var(--color-text-muted);
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
  }

  .nav-links a:hover {
    color: var(--color-text);
    text-decoration: none;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-weight: 600;
    text-decoration: none;
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

  .btn-sm {
    font-size: 0.8125rem;
    padding: 0.375rem 0.875rem;
  }

  @media (max-width: 640px) {
    .nav-links a:not(.btn) {
      display: none;
    }
  }
</style>
