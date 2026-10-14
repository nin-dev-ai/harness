import { defineConfig } from "vitest/config";

// Workspace packages resolve to src/ through the "source" export condition.
const conditions = ["source", "import", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: true,
    testTimeout: 20_000,
    pool: "forks",
    // Tests never depend on the user's git config.
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  },
});
