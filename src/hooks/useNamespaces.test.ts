import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileNamespaceCache } from "./useNamespaces";

/**
 * Regression coverage for the rename/delete cache path: a retired namespace
 * name must be dropped from the cache, never invalidated. Invalidating it
 * refetches `GET /namespaces/{old}` — which the gateway no longer resolves —
 * and pops a spurious 404 on top of an otherwise successful mutation.
 */
describe("reconcileNamespaceCache", () => {
  let qc: QueryClient;

  const seed = (names: string[]) => {
    qc.setQueryData(["namespaces"], names);
    for (const name of names) {
      qc.setQueryData(["namespace", name], {
        name,
        created_at: "2026-08-24T00:00:00Z",
        updated_at: "2026-08-24T00:00:00Z",
      });
    }
  };

  const detailKeys = () =>
    qc
      .getQueryCache()
      .findAll({ queryKey: ["namespace"] })
      .map((query) => query.queryKey[1] as string)
      .sort();

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("drops the old detail entry on a rename", () => {
    seed(["ferrum", "production"]);

    reconcileNamespaceCache(qc, "production", "production-eu");

    expect(detailKeys()).toEqual(["ferrum"]);
    expect(qc.getQueryData(["namespace", "production"])).toBeUndefined();
  });

  it("drops the detail entry on a delete", () => {
    seed(["ferrum", "staging"]);

    reconcileNamespaceCache(qc, "staging", null);

    expect(detailKeys()).toEqual(["ferrum"]);
    expect(qc.getQueryData(["namespace", "staging"])).toBeUndefined();
  });

  it("keeps and invalidates the detail entry on a description-only update", () => {
    seed(["ferrum", "staging"]);

    reconcileNamespaceCache(qc, "staging", "staging");

    // The name still resolves, so the entry survives — marked stale, not removed.
    expect(detailKeys()).toEqual(["ferrum", "staging"]);
    expect(qc.getQueryState(["namespace", "staging"])?.isInvalidated).toBe(true);
  });

  it("never touches sibling namespaces' detail entries", () => {
    seed(["ferrum", "staging", "production"]);

    reconcileNamespaceCache(qc, "production", "production-eu");

    expect(qc.getQueryState(["namespace", "ferrum"])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(["namespace", "staging"])?.isInvalidated).toBe(false);
  });

  it("always invalidates the namespace list", () => {
    seed(["ferrum"]);

    reconcileNamespaceCache(qc, "ferrum", "ferrum");

    expect(qc.getQueryState(["namespaces"])?.isInvalidated).toBe(true);
  });

  it("invalidates the list even when the namespace was deleted", () => {
    seed(["ferrum", "staging"]);

    reconcileNamespaceCache(qc, "staging", null);

    expect(qc.getQueryState(["namespaces"])?.isInvalidated).toBe(true);
  });
});
