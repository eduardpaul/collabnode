import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

/**
 * The inference rules in `src/infer.ts` have no runtime to test — they are only
 * ever wrong at compile time. `typecheck` runs `tsc` over `tests/*.test-d.ts`,
 * where a wrong rule or an `@ts-expect-error` that stopped erroring is a failure
 * like any other. The package's own `tsconfig` covers `src` only, so without
 * this those files would never be checked at all.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        include: ["tests/**/*.test-d.ts"],
        // The package tsconfig covers `src` only, so pointing tsc at it checks
        // everything except the file we are trying to check.
        tsconfig: "./tests/tsconfig.json",
      },
    },
  }),
);
