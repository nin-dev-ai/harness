import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: true,
    testTimeout: 20_000,
    pool: "forks",
  },
});
