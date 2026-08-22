import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      ".claude/**",
      "**/dist/**",
      "**/*.d.ts",
      "**/public/**",
      "**/*.min.js",
    ],
  },
  sonarjs.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.js", "**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Sonar's unused-var rule takes no options, so it cannot be taught the
      // `const { id: _id, ...rest } = props` omit idiom. Use the typescript-eslint
      // rule instead, which understands both `_` prefixes and rest siblings.
      "sonarjs/no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // `[A-Za-z0-9_]` over `\w` is deliberate: these classes sanitize SQL/Cypher
      // identifiers, where spelling the allowed set out is the point.
      "sonarjs/concise-regex": "off",

      // `void _never` is our exhaustiveness marker in `default:` branches.
      "sonarjs/void-use": "off",
    },
  },
  {
    // Examples are runnable demos: plain top-level assertion scripts executed by
    // `node src/*.test.ts`, not framework suites, and their IDs need no CSPRNG.
    files: ["examples/**"],
    rules: {
      "sonarjs/no-empty-test-file": "off",
      "sonarjs/pseudo-random": "off",
    },
  },
  {
    // A local dev-server harness: `npx tinylicious`, plus `pkill`/`taskkill` for
    // teardown. Resolving these from PATH is the intended behaviour here.
    files: ["packages/fluid/src/tinylicious-process.ts"],
    rules: { "sonarjs/no-os-command-from-path": "off" },
  },
  {
    files: ["packages/bench/**"],
    rules: { "sonarjs/pseudo-random": "off" },
  },
  {
    // Test code legitimately spawns dev servers, uses tmpdir(), and talks http
    // to localhost fixtures.
    files: ["**/tests/**", "**/*.test.ts"],
    rules: {
      "sonarjs/publicly-writable-directories": "off",
      "sonarjs/no-os-command-from-path": "off",
      "sonarjs/no-clear-text-protocols": "off",
    },
  },
];
