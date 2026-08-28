import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

/**
 * `plan-zod.test.ts` asserts that the compile-time shapes and the runtime
 * validator agree, and half of that claim is only checkable by a type checker.
 * The package tsconfig covers `src` only, so tests get their own.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        // Scoped to this one file on purpose: the rest of the suite predates this
        // and carries its own type errors, which are not this change's to fix.
        include: ["tests/plan-zod.test.ts"],
        tsconfig: "./tests/tsconfig.json",
      },
    },
  }),
);
