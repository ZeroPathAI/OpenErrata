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
  "@typescript-eslint/no-unnecessary-condition": [
    "error",
    { allowConstantLoopConditions: true },
  ],
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/no-misused-spread": "error",
  "@typescript-eslint/no-implied-eval": "error",
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/consistent-type-exports": "error",
  "@typescript-eslint/explicit-module-boundary-types": "error",
  "@typescript-eslint/return-await": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  "@typescript-eslint/no-unnecessary-template-expression": "error",
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
  ...ts.configs.recommended,
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
