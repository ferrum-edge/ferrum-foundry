import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "dist-server/", "coverage/", "node_modules/"] },
  {
    // Every TypeScript file `npm run lint` names: a directory argument lints
    // only files some block matches, so a path missing here is skipped
    // silently (#675).
    files: ["src/**/*.{ts,tsx}", "server/**/*.ts", "e2e/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Intentional escape hatches used at API boundaries
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "shared/**/*.js", "e2e/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Playwright reads a fixture's dependencies from its destructured first
    // parameter, so a fixture that needs none must declare `{}`.
    files: ["e2e/**/*.ts"],
    rules: {
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
    },
  },
  {
    files: ["src/**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Classic hooks rules only — the react-compiler diagnostics bundled in
      // the recommended preset are too strict for this codebase today.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": "off",
    },
  },
);
