import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

/**
 * The selectors in `src/select.ts` are a `filter` at runtime and a narrowing at
 * compile time, and only the second half is worth testing. The package tsconfig
 * covers `src` only, so the type tests get their own.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        include: ["tests/**/*.test-d.ts"],
        tsconfig: "./tests/tsconfig.json",
      },
    },
  }),
);
