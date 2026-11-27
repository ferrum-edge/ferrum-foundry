import { describe, expect, it } from "vitest";
import { isAddressableResourceId } from "./resourceId";

describe("isAddressableResourceId", () => {
  it("accepts Edge's item-route ID grammar", () => {
    for (const id of ["proxy-1", "a", "9.b_c-d", "Orders.API"]) expect(isAddressableResourceId(id), id).toBe(true);
  });

  it("rejects the mesh runtime's synthesized IDs and anything else Edge refuses", () => {
    for (const id of ["__mesh-inbound-ns-svc-18080", "__mesh_spiffe_identity", "-lead", ".lead", "a/b", "a b", ""]) {
      expect(isAddressableResourceId(id), id).toBe(false);
    }
  });
});
