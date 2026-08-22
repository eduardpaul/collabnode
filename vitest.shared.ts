import { defineConfig } from "vitest/config";

/**
 * Shared vitest defaults for every workspace package.
 *
 * `maxWorkers` is capped instead of left at vitest's default of
 * `availableParallelism() - 1`. On a 16-core machine that default spawns 15
 * Node runtimes per package, and `pnpm -r test` multiplies it by the workspace
 * concurrency — enough to exhaust memory on a laptop or a WSL VM.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 4,
  },
});
