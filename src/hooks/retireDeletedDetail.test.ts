import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { retireDeletedDetail } from "./retireDeletedDetail";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("retireDeletedDetail", () => {
  it("cancels then removes the exact detail entry and leaves siblings", async () => {
    const qc = client();
    const queryKey = ["proxy", "tenant-a", "gone"];
    const siblingKey = ["proxy", "tenant-a", "kept"];
    const listKey = ["proxies", "tenant-a"];
    qc.setQueryData(queryKey, { id: "gone" });
    qc.setQueryData(siblingKey, { id: "kept" });
    qc.setQueryData(listKey, { data: [] });

    const cancel = vi.spyOn(qc, "cancelQueries");
    const remove = vi.spyOn(qc, "removeQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    await retireDeletedDetail(qc, queryKey);

    expect(cancel).toHaveBeenCalledWith({ queryKey, exact: true });
    expect(remove).toHaveBeenCalledWith({ queryKey, exact: true });
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0]!,
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryData(queryKey)).toBeUndefined();
    expect(qc.getQueryState(queryKey)).toBeUndefined();
    expect(qc.getQueryData(siblingKey)).toEqual({ id: "kept" });
    expect(qc.getQueryState(listKey)?.isInvalidated).toBeFalsy();
  });

  it("cancels an in-flight fetch before dropping the entry", async () => {
    const qc = client();
    const queryKey = ["proxy", "tenant-a", "gone"];
    let started = false;
    let aborted = false;
    const hanging = qc.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => {
        started = true;
        return new Promise((_resolve, reject) => {
          const fail = () => {
            aborted = true;
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          };
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));

    await retireDeletedDetail(qc, queryKey);

    await expect(hanging).rejects.toBeDefined();
    expect(aborted).toBe(true);
    expect(qc.getQueryData(queryKey)).toBeUndefined();
    expect(qc.getQueryState(queryKey)).toBeUndefined();
  });
});
