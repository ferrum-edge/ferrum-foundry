import { describe, expect, it } from "vitest";

const SEGMENT_INTERPOLATION_PATTERN = /\/\$\{([^}]+)\}/g;

const apiModules = import.meta.glob<string>("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("Admin API dynamic path segments", () => {
  it("encodes every interpolated segment in API module path templates", () => {
    const violations: string[] = [];
    // maskedSecrets builds JSON Pointers, not Admin API request paths.
    for (const [filename, source] of Object.entries(apiModules)) {
      if (filename.endsWith(".test.ts") || filename === "./maskedSecrets.ts") continue;

      for (const match of source.matchAll(SEGMENT_INTERPOLATION_PATTERN)) {
        if (!match[1]?.startsWith("pathSegment(")) {
          violations.push(`${filename.slice(2)}: ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
