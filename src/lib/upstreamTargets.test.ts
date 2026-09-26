import { describe, expect, it } from "vitest";
import { resourceFingerprint } from "./resourceBaseline";
import { identityAfterRemoval, normalizedTargets, targetIdentities } from "./upstreamTargets";

const target = (host: string, port = 80) => ({ host, port, weight: 1 });

describe("identityAfterRemoval", () => {
  it("renumbers a later duplicate when an earlier one is removed", () => {
    const ids = targetIdentities([target("a"), target("a"), target("b"), target("a")]);
    expect(ids).toEqual(["a:80#0", "a:80#1", "b:80#0", "a:80#2"]);
    expect(identityAfterRemoval("a:80#1", "a:80#0")).toBe("a:80#0");
    expect(identityAfterRemoval("a:80#2", "a:80#1")).toBe("a:80#1");
  });

  it("leaves an identity alone when the removed target is later or has another address", () => {
    expect(identityAfterRemoval("a:80#0", "a:80#1")).toBe("a:80#0");
    expect(identityAfterRemoval("a:80#1", "b:80#0")).toBe("a:80#1");
    expect(identityAfterRemoval("a:80#1", "a:8080#0")).toBe("a:80#1");
  });

  it("matches the identities of the list without the removed target", () => {
    const targets = [target("a"), target("b"), target("a"), target("a")];
    const before = targetIdentities(targets);
    for (let removed = 0; removed < targets.length; removed += 1) {
      const after = targetIdentities(targets.filter((_, index) => index !== removed));
      const kept = before.filter((_, index) => index !== removed);
      expect(kept.map((id) => identityAfterRemoval(id, before[removed]))).toEqual(after);
    }
  });
});

describe("normalizedTargets", () => {
  const same = (a: Parameters<typeof normalizedTargets>[0], b: typeof a) =>
    resourceFingerprint({ targets: normalizedTargets(a) }) ===
    resourceFingerprint({ targets: normalizedTargets(b) });

  it("treats absent and empty optional members as the same list", () => {
    expect(same(
      [{ ...target("a"), path: null, locality: null, tags: {} }],
      [target("a")],
    )).toBe(true);
  });

  it("keeps every real difference", () => {
    expect(same([{ ...target("a"), path: "/v1" }], [target("a")])).toBe(false);
    expect(same([{ ...target("a"), tags: { v: "1" } }], [target("a")])).toBe(false);
    expect(same([{ ...target("a"), weight: 2 }], [target("a")])).toBe(false);
    expect(same([target("a"), target("b")], [target("b"), target("a")])).toBe(false);
    expect(same([target("a")], [{ ...target("a"), extra: 1 } as ReturnType<typeof target>])).toBe(false);
  });
});
