import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import prettier from "eslint-config-prettier";

/**
 * Type-aware rule overrides for .ts files only (require projectService).
 * We layer strictTypeChecked + stylisticTypeChecked, then pin project-specific
 * expectations here to avoid accidental strictness drift.
 *
 * NOT enabled for .svelte — svelte-eslint-parser + projectService is too slow.
 * svelte-check covers type errors in .svelte instead.
 */
const typeAwareRuleOverrides = {
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
  "@typescript-eslint/no-unsafe-type-assertion": "error",

  // ── Binding safety ─────────────────────────────────────────────
  "@typescript-eslint/no-shadow": "error",
  "@typescript-eslint/no-use-before-define": [
    "error",
    {
      functions: false,
      classes: true,
      variables: true,
      typedefs: true,
      allowNamedExports: false,
    },
  ],

  // ── Operator/template strictness ──────────────────────────────
  "@typescript-eslint/restrict-plus-operands": "error",
  "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
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
  "@typescript-eslint/strict-boolean-expressions": [
    "error",
    {
      allowNullableObject: true,
      allowNullableBoolean: true,
      allowString: false,
      allowNumber: false,
      allowNullableString: false,
      allowNullableNumber: false,
    },
  ],

  // ── Unnecessary / redundant code ──────────────────────────────
  "@typescript-eslint/no-unnecessary-condition": ["error", { allowConstantLoopConditions: true }],
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-unnecessary-type-arguments": "error",
  "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
  "@typescript-eslint/no-unnecessary-template-expression": "error",
  "@typescript-eslint/no-redundant-type-constituents": "error",
  "@typescript-eslint/no-duplicate-type-constituents": "error",
  "@typescript-eslint/no-empty-object-type": "error",
  "@typescript-eslint/no-mixed-enums": "error",
  "@typescript-eslint/no-unnecessary-parameter-property-assignment": "error",
  "@typescript-eslint/no-unnecessary-qualifier": "error",

  // ── Void discipline ───────────────────────────────────────────
  "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
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
  "@typescript-eslint/no-unnecessary-type-parameters": "error",
  "@typescript-eslint/prefer-regexp-exec": "error",
  "@typescript-eslint/related-getter-setter-pairs": "error",
};

const typeAwareTsFiles = ["**/*.ts"];

const typeAwareTsIgnores = [
  "**/*.d.ts",
  "**/vite.config.ts",
  "**/svelte.config.js",
  "extension/playwright.config.ts",
  "test-support/*.ts",
];

const typeAwarePresetConfigs = [
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,
].map((config) => ({
  ...config,
  files: typeAwareTsFiles,
  ignores: typeAwareTsIgnores,
}));

const extensionRuntimeBoundaryFiles = [
  "extension/src/background/api-client.ts",
  "extension/src/background/index.ts",
  "extension/src/content/sync.ts",
  "extension/src/lib/protocol-version.ts",
  "extension/src/lib/sync-response.ts",
  "extension/src/lib/view-post-input.ts",
];

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
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
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
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-useless-catch": "error",
      "no-constructor-return": "error",
      "no-promise-executor-return": "error",
      "no-sequences": "error",
      "no-script-url": "error",
      "no-proto": "error",
      "no-void": ["error", { allowAsStatement: true }],
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
          "ts-expect-error": {
            descriptionFormat: "^(?:[A-Z]{2,}-\\d+|https?://\\S+)\\s+-\\s+.+$",
          },
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
    files: ["api/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator[init.type='CallExpression'][init.callee.name='getEnv']",
          message:
            "Do not read getEnv() in top-level module initializers. Resolve env lazily inside functions so imports stay side-effect free.",
        },
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator[init.type='MemberExpression'][init.object.type='CallExpression'][init.object.callee.name='getEnv']",
          message:
            "Do not read getEnv() in top-level module initializers. Resolve env lazily inside functions so imports stay side-effect free.",
        },
        {
          selector:
            "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type='CallExpression'][init.callee.name='getEnv']",
          message:
            "Do not read getEnv() in top-level module initializers. Resolve env lazily inside functions so imports stay side-effect free.",
        },
        {
          selector:
            "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type='MemberExpression'][init.object.type='CallExpression'][init.object.callee.name='getEnv']",
          message:
            "Do not read getEnv() in top-level module initializers. Resolve env lazily inside functions so imports stay side-effect free.",
        },
      ],
    },
  },
  {
    files: ["extension/src/**/*.{js,ts,svelte}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@openerrata/api",
              message:
                "Do not import from @openerrata/api in extension runtime code. Depend on @openerrata/shared contracts only.",
            },
          ],
          patterns: [
            {
              group: ["@openerrata/api/*"],
              message:
                "Do not import from @openerrata/api in extension runtime code. Depend on @openerrata/shared contracts only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["extension/scripts/**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...typeAwarePresetConfigs,
  {
    // Type-aware linting for .ts files only, including extension code.
    files: typeAwareTsFiles,
    ignores: typeAwareTsIgnores,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "extension/test/unit/*.ts",
            "extension/test/helpers/*.ts",
            "extension/test/e2e/*.ts",
            "shared/test/unit/*.ts",
          ],
          defaultProject: "tsconfig.base.json",
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 512,
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      ...typeAwareRuleOverrides,
      // Disable base ESLint rules superseded by TS-aware equivalents
      "no-throw-literal": "off",
      "require-await": "off",
      "no-shadow": "off",
      "no-use-before-define": "off",
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
    files: extensionRuntimeBoundaryFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='parse'][callee.object.type='Identifier'][callee.object.name=/Schema$/][arguments.0.type!='ObjectExpression']",
          message:
            "Do not call schema.parse(...) on non-literal boundary data in extension runtime adapters. Use safeParse(...) and map failures to INVALID_EXTENSION_MESSAGE.",
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
      "@typescript-eslint/no-empty-function": "off",
      // Tests intentionally exercise malformed and unknown inputs.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/unbound-method": "off",
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
      "svelte/no-target-blank": ["error", { allowReferrer: false, enforceDynamicLinks: "always" }],
      "svelte/no-dupe-style-properties": "error",
      "svelte/no-dupe-else-if-blocks": "error",
    },
  },
];
