import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import prettier from "eslint-config-prettier";

/**
 * Type-aware rules for .ts files only (require projectService).
 * NOT enabled for .svelte — svelte-eslint-parser + projectService is too slow.
 * svelte-check covers type errors in .svelte instead.
 */
const typeAwareRules = {
  // ── Async safety ──────────────────────────────────────────────
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/return-await": "error",

  // ── Type safety — block any/unsafe ────────────────────────────
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-enum-comparison": "error",
  "@typescript-eslint/no-unsafe-declaration-merging": "error",

  // ── Operator/template strictness ──────────────────────────────
  "@typescript-eslint/restrict-plus-operands": "error",
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    { allowNumber: true },
  ],
  "@typescript-eslint/no-base-to-string": "error",

  // ── Array/iteration safety ────────────────────────────────────
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/no-misused-spread": "error",
  "@typescript-eslint/no-array-delete": "error",

  // ── Code-from-string / eval ───────────────────────────────────
  "@typescript-eslint/no-implied-eval": "error",

  // ── Method binding ────────────────────────────────────────────
  "@typescript-eslint/unbound-method": "error",

  // ── Catch / error handling ────────────────────────────────────
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

  // ── Unnecessary / redundant code ──────────────────────────────
  "@typescript-eslint/no-unnecessary-condition": [
    "error",
    { allowConstantLoopConditions: true },
  ],
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-unnecessary-type-arguments": "error",
  "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
  "@typescript-eslint/no-unnecessary-template-expression": "error",
  "@typescript-eslint/no-redundant-type-constituents": "error",
  "@typescript-eslint/no-duplicate-type-constituents": "error",
  "@typescript-eslint/no-mixed-enums": "error",

  // ── Void discipline ───────────────────────────────────────────
  "@typescript-eslint/no-confusing-void-expression": [
    "error",
    { ignoreArrowShorthand: true },
  ],
  "@typescript-eslint/no-meaningless-void-operator": "error",

  // ── Exhaustiveness / assertions ───────────────────────────────
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-deprecated": "error",

  // ── Import/export type discipline ─────────────────────────────
  "@typescript-eslint/consistent-type-exports": "error",
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      prefer: "type-imports",
      fixStyle: "inline-type-imports",
      disallowTypeAnnotations: false,
    },
  ],
  "@typescript-eslint/no-import-type-side-effects": "error",

  // ── Module boundary ───────────────────────────────────────────
  "@typescript-eslint/explicit-module-boundary-types": "error",

  // ── Preference upgrades (prevent subtle bugs) ─────────────────
  "@typescript-eslint/prefer-nullish-coalescing": "error",
  "@typescript-eslint/prefer-optional-chain": "error",
  "@typescript-eslint/prefer-includes": "error",
  "@typescript-eslint/prefer-find": "error",
  "@typescript-eslint/prefer-string-starts-ends-with": "error",
  "@typescript-eslint/prefer-reduce-type-parameter": "error",
  "@typescript-eslint/prefer-return-this-type": "error",
  "@typescript-eslint/dot-notation": "error",
};

export default [
  {
    ignores: [
      ".DS_Store",
      "**/node_modules/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/dist/**",
      ".env",
      ".env.*",
      "!.env.example",
      "pnpm-lock.yaml",
      "**/prisma/migrations/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.strict,
  ...svelte.configs["flat/recommended"],
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_|^\\$\\$",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Security: block code-from-string execution vectors
      "no-eval": "error",
      "no-implied-eval": "off", // use @typescript-eslint version in type-aware override
      "no-new-func": "error",
      // Correctness
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      "no-throw-literal": "error",
      // Type safety — applied globally (both .ts and .svelte)
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          "ts-check": false,
          minimumDescriptionLength: 12,
        },
      ],
    },
  },
  {
    files: ["api/**/*.{js,ts}", "shared/**/*.{js,ts}", "pulumi/**/*.{js,ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["extension/**/*.{js,ts,svelte}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    // Type-aware linting for .ts files only, including extension code.
    files: ["**/*.ts"],
    ignores: [
      "**/*.d.ts",
      "**/vite.config.ts",
      "**/svelte.config.js",
      "extension/playwright.config.ts",
      "extension/test/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      ...typeAwareRules,
      // Disable base ESLint rules superseded by TS-aware equivalents
      "no-throw-literal": "off",
      "require-await": "off",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "never",
        },
      ],
    },
  },
  {
    // Node's `test(...)` registration calls are intentionally un-awaited.
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Non-type-aware linting for .svelte files.
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-undef": "off",
      "svelte/no-target-blank": [
        "error",
        { allowReferrer: false, enforceDynamicLinks: "always" },
      ],
      "svelte/no-dupe-style-properties": "error",
      "svelte/no-dupe-else-if-blocks": "error",
    },
  },
];
