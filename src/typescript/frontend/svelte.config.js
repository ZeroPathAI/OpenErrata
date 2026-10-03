import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      out: "build",
    }),
    // SvelteKit adds nonces/hashes for its own inline scripts. External origins:
    // Google Fonts serves the Inter stylesheet (fonts.googleapis.com) and font
    // files (fonts.gstatic.com). Nothing else is loaded from third parties.
    // Style attributes stay allowed: SvelteKit's navigation announcer and
    // markdown-it's table alignment use them, and they cannot run script.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "https://fonts.googleapis.com"],
        "style-src-attr": ["unsafe-inline"],
        "font-src": ["https://fonts.gstatic.com"],
        "img-src": ["self"],
        "connect-src": ["self"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
        "frame-ancestors": ["none"],
      },
    },
  },
};

export default config;
