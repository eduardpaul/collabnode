import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

/**
 * These hooks only do anything once React runs their effects, and that needs a
 * document. `jsdom` is what lets a test mount `useCollab` and then unmount it,
 * which is the only way to see whether the session it opened was closed.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    },
  }),
);
