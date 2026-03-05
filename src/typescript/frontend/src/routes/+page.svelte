<svelte:head>
  <title>OpenErrata - AI-Powered Fact-Checking for the Web</title>
</svelte:head>

<div class="page">
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="logo">OpenErrata</a>
      <div class="nav-links">
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

  <header class="hero">
    <div class="hero-inner">
      <div class="hero-badge">Open Source</div>
      <h1>Fact-check what you read,<br />as you read it.</h1>
      <p class="hero-subtitle">
        OpenErrata is a browser extension that uses AI to investigate the content you read online
        and provides inline corrections to empirically incorrect or misleading claims.
      </p>
      <div class="hero-actions">
        <a
          href="https://chromewebstore.google.com/detail/openerrata/TODO"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-primary">Install for Chrome</a
        >
        <a
          href="https://github.com/ZeroPathAI/openerrata"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-secondary">View on GitHub</a
        >
      </div>
    </div>
  </header>

  <section class="principles">
    <div class="section-inner">
      <div class="principles-grid">
        <div class="principle">
          <div class="principle-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <h3>Unimpeachable results</h3>
          <p>
            Corrections are restricted to claims that are relatively uncontestable. If a reasonable
            person from any perspective wouldn't update on a correction, it isn't shown.
          </p>
        </div>
        <div class="principle">
          <div class="principle-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <h3>Fully transparent</h3>
          <p>
            The design, spec, code, and every individual investigation are publicly available. You
            can inspect exactly why any correction was made.
          </p>
        </div>
        <div class="principle">
          <div class="principle-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5Z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <h3>Non-intrusive</h3>
          <p>
            Unchecked posts show nothing. Checked posts get subtle highlights that reveal details on
            hover, so the reading experience is never disrupted.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section id="how-it-works" class="how-it-works">
    <div class="section-inner">
      <h2>How it works</h2>
      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <div class="step-content">
            <h3>You browse normally</h3>
            <p>
              The extension detects when you visit a supported page and sends the content to the
              OpenErrata service for analysis.
            </p>
          </div>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <div class="step-content">
            <h3>AI investigates the claims</h3>
            <p>
              An LLM searches the web for primary sources, cross-references statistics, verifies
              quotes, and checks empirical claims against available evidence.
            </p>
          </div>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <div class="step-content">
            <h3>Each claim is validated</h3>
            <p>
              Every potential correction goes through a second-stage validation to filter out
              anything that doesn't meet the bar for being unambiguously incorrect.
            </p>
          </div>
        </div>
        <div class="step">
          <div class="step-number">4</div>
          <div class="step-content">
            <h3>Corrections appear inline</h3>
            <p>
              Verified corrections are highlighted directly in the page. Hover to see what's wrong
              and why, with links to the full investigation.
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="platforms" class="platforms">
    <div class="section-inner">
      <h2>Supported platforms</h2>
      <p class="section-subtitle">
        OpenErrata currently fact-checks posts on these platforms, with more coming soon.
      </p>
      <div class="platform-grid">
        <div class="platform-card">
          <span class="platform-name">LessWrong</span>
        </div>
        <div class="platform-card">
          <span class="platform-name">X (Twitter)</span>
        </div>
        <div class="platform-card">
          <span class="platform-name">Substack</span>
        </div>
        <div class="platform-card">
          <span class="platform-name">Wikipedia</span>
        </div>
      </div>
    </div>
  </section>

  <section class="self-host">
    <div class="section-inner">
      <div class="self-host-card">
        <h2>Self-host your own instance</h2>
        <p>
          OpenErrata ships as a single Helm chart. Bring your own Postgres database, an OpenAI API
          key, and an S3-compatible bucket. The extension connects to whichever instance you
          configure.
        </p>
        <a
          href="https://github.com/ZeroPathAI/openerrata"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-secondary">Deployment docs</a
        >
      </div>
    </div>
  </section>

  <footer class="footer">
    <div class="section-inner footer-inner">
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
        <a
          href="https://github.com/ZeroPathAI/openerrata/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer">License</a
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

  /* Nav */
  .nav {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
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

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.9375rem;
    padding: 0.625rem 1.25rem;
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

  /* Hero */
  .hero {
    padding: 10rem 1.5rem 5rem;
    text-align: center;
  }

  .hero-inner {
    max-width: var(--max-width);
    margin: 0 auto;
  }

  .hero-badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    margin-bottom: 1.5rem;
  }

  .hero h1 {
    font-size: clamp(2.25rem, 5vw, 3.75rem);
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.025em;
    margin-bottom: 1.5rem;
  }

  .hero-subtitle {
    font-size: 1.125rem;
    color: var(--color-text-muted);
    line-height: 1.6;
    max-width: 640px;
    margin: 0 auto 2.5rem;
  }

  .hero-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* Principles */
  .principles {
    padding: 4rem 1.5rem;
  }

  .section-inner {
    max-width: var(--max-width);
    margin: 0 auto;
  }

  .principles-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .principle {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .principle-icon {
    width: 2.5rem;
    height: 2.5rem;
    color: var(--color-accent);
    margin-bottom: 1rem;
  }

  .principle-icon svg {
    width: 100%;
    height: 100%;
  }

  .principle h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }

  .principle p {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    line-height: 1.6;
  }

  /* How it works */
  .how-it-works {
    padding: 5rem 1.5rem;
  }

  .how-it-works h2,
  .platforms h2,
  .self-host h2 {
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin-bottom: 2.5rem;
    text-align: center;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    max-width: 640px;
    margin: 0 auto;
  }

  .step {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
  }

  .step-number {
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    background: var(--color-accent);
    color: #000;
    font-weight: 700;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .step-content h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.375rem;
  }

  .step-content p {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    line-height: 1.6;
  }

  /* Platforms */
  .platforms {
    padding: 5rem 1.5rem;
  }

  .section-subtitle {
    text-align: center;
    color: var(--color-text-muted);
    font-size: 1rem;
    margin-top: -1.5rem;
    margin-bottom: 2.5rem;
  }

  .platform-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .platform-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1.5rem;
    text-align: center;
    transition:
      border-color 0.15s,
      background 0.15s;
  }

  .platform-card:hover {
    border-color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .platform-name {
    font-weight: 600;
    font-size: 1rem;
  }

  /* Self-host */
  .self-host {
    padding: 3rem 1.5rem 5rem;
  }

  .self-host-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    padding: 3rem;
    text-align: center;
  }

  .self-host-card p {
    color: var(--color-text-muted);
    font-size: 1rem;
    line-height: 1.6;
    max-width: 600px;
    margin: 0 auto 1.5rem;
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
    .nav-links a:not(.btn) {
      display: none;
    }

    .hero {
      padding: 7rem 1rem 3rem;
    }

    .hero-subtitle {
      font-size: 1rem;
    }

    .self-host-card {
      padding: 2rem 1.5rem;
    }

    .footer-inner {
      flex-direction: column;
      gap: 0.75rem;
    }
  }
</style>
