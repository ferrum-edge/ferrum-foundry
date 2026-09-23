import { describe, expect, it } from "vitest";
import {
  formatCommaList,
  missingNumberError,
  numberDraftFromInput,
  numberDraftText,
  parseCommaList,
  parseStatusCodeList,
  resolveNumberDrafts,
  resolveStatusCodeListDraft,
  statusCodeListDraft,
} from "./formDrafts";

describe("numeric drafts", () => {
  it("keeps an empty entry empty instead of converting it to 0", () => {
    expect(numberDraftFromInput("")).toBe("");
    expect(numberDraftFromInput("0")).toBe(0);
    expect(numberDraftFromInput("8080")).toBe(8080);
    expect(numberDraftText("")).toBe("");
    expect(numberDraftText(undefined)).toBe("");
    expect(numberDraftText(null)).toBe("");
    expect(numberDraftText(0)).toBe("0");
  });

  it("reports only an empty draft as missing", () => {
    expect(missingNumberError("", "Backend port")).toBe("Backend port is required");
    expect(missingNumberError(0, "Backend port")).toBeUndefined();
    expect(missingNumberError(undefined, "Backend port")).toBeUndefined();
  });

  it("resolves validated drafts unchanged and refuses an empty one", () => {
    const draft = { interval_seconds: 10, timeout_ms: 5000 as number | "", http_path: "/health" };
    expect(resolveNumberDrafts(draft, ["interval_seconds", "timeout_ms"])).toBe(draft);
    expect(() => resolveNumberDrafts({ ...draft, timeout_ms: "" }, ["timeout_ms"]))
      .toThrow("timeout_ms");
  });
});

describe("comma lists", () => {
  it("formats and splits entries, ignoring empty segments", () => {
    expect(formatCommaList(["tenant-a", "tenant-b"])).toBe("tenant-a, tenant-b");
    expect(formatCommaList(undefined)).toBe("");
    expect(parseCommaList(" tenant-a , tenant-b, ")).toEqual(["tenant-a", "tenant-b"]);
    expect(parseCommaList("tenant-a,")).toEqual(["tenant-a"]);
    expect(parseCommaList("  ")).toEqual([]);
  });
});

describe("status-code lists", () => {
  it("accepts complete codes within the gateway range", () => {
    expect(parseStatusCodeList("200, 302")).toEqual({ ok: true, codes: [200, 302] });
    expect(parseStatusCodeList("100,599")).toEqual({ ok: true, codes: [100, 599] });
    expect(parseStatusCodeList("")).toEqual({ ok: true, codes: [] });
  });

  it.each(["200x", "20.5", "99", "600", "-200", "2e2", "abc"])(
    "rejects %j instead of truncating it",
    (token) => {
      const result = parseStatusCodeList(`200, ${token}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`"${token}"`);
    },
  );

  it("returns the seeded list for untouched text, including an absent one", () => {
    expect(resolveStatusCodeListDraft(statusCodeListDraft(undefined)))
      .toEqual({ ok: true, codes: undefined });
    const seeded = statusCodeListDraft([200, 302]);
    expect(seeded.text).toBe("200, 302");
    expect(resolveStatusCodeListDraft(seeded)).toEqual({ ok: true, codes: [200, 302] });
    expect(resolveStatusCodeListDraft({ ...seeded, text: "204" }))
      .toEqual({ ok: true, codes: [204] });
    expect(resolveStatusCodeListDraft({ ...seeded, text: "" }))
      .toEqual({ ok: true, codes: [] });
  });
});
