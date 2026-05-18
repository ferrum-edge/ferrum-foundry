import { defineConfig } from "vitest/config";
import path from "node:path";

const sharedAlias = {
  "@": path.resolve(__dirname, "src"),
};

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    // Coverage settings apply to whichever project(s) run.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
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
