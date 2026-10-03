import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDirectory = fileURLToPath(new URL(".", import.meta.url));

describe("Admin API dynamic path segments", () => {
  it("encodes every interpolated segment in API module path templates", () => {
    const violations: string[] = [];
    const segmentInterpolation = /\/\$\{([^}]+)\}/g;

    // maskedSecrets builds JSON Pointers, not Admin API request paths.
    for (const filename of readdirSync(apiDirectory).filter(
      (name) =>
        name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "maskedSecrets.ts",
    )) {
      const source = readFileSync(new URL(filename, import.meta.url), "utf8");
      for (const match of source.matchAll(segmentInterpolation)) {
        if (!match[1]?.startsWith("pathSegment(")) {
          violations.push(`${filename}: ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
