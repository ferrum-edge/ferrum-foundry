import { defineConfig } from "vitest/config";
import path from "node:path";

const sharedAlias = {
  "@": path.resolve(import.meta.dirname, "src"),
};

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    // Coverage settings apply to whichever project(s) run.
    coverage: {
      provider: "v8",
      // The `skipFull: false` option is passed per-reporter (not on the
      // coverage block) because vitest force-overrides text-reporter options
      // to `skipFull: true` when it detects an agent/CI environment. Without
      // this, files at 100% coverage (e.g. server/jwt.ts, server/auth.ts)
      // silently disappear from the text report and look "untested".
      reporter: [["text", { skipFull: false }], "html", "lcov"],
      // v8 only instruments modules touched at runtime; explicit `include`
      // surfaces server-side files that tests reach via `vi.resetModules()`
      // + dynamic import (e.g. server/jwt.ts) so they appear in the report.
      include: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
      thresholds: {
        // Ratchet the measured launch baseline. Server-side security code has
        // a substantially higher floor than the still-growing UI suite.
        statements: 17,
        branches: 14,
        functions: 9,
        lines: 17,
        "server/**/*.ts": {
          statements: 75,
          branches: 65,
          functions: 70,
          lines: 75,
        },
      },
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/routeTree.gen.ts",
      ],
    },
    projects: [
      {
        resolve: {
          alias: sharedAlias,
        },
        test: {
          name: "frontend",
          environment: "jsdom",
          globals: false,
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          globals: false,
          include: ["server/**/*.test.ts"],
        },
      },
    ],
  },
});
