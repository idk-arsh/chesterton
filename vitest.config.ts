import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/**"],
    setupFiles: ["test/helpers/yield.ts"],
    // Tests make real git repos; on Windows with the whole suite in parallel a few take seconds.
    testTimeout: 30_000,
  },
});
