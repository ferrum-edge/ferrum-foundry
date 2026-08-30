import { describe, expect, it } from "vitest";
import { getGatewayTrustRevisionConflict } from "./trust";

function conflict(data: unknown, status = 409): Error {
  return Object.assign(new Error("conflict"), { response: { status }, data });
}

describe("getGatewayTrustRevisionConflict", () => {
  it("recognizes only the canonical optimistic-concurrency conflict", () => {
    expect(
      getGatewayTrustRevisionConflict(
        conflict({
          error: "revision mismatch",
          expected_revision: 41,
          current_revision: 42,
        }),
      ),
    ).toEqual({
      error: "revision mismatch",
      expected_revision: 41,
      current_revision: 42,
    });
  });

  it.each([
    [409, { error: "already exists" }],
    [400, { error: "revision mismatch", expected_revision: 1, current_revision: 2 }],
    [409, { error: "revision mismatch", expected_revision: 1.5, current_revision: 2 }],
    [409, { error: "revision mismatch", expected_revision: 1, current_revision: 2, extra: true }],
  ])("rejects noncanonical response %#", (status, data) => {
    expect(getGatewayTrustRevisionConflict(conflict(data, status))).toBeNull();
  });
});
