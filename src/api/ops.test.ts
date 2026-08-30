import { describe, expect, it } from "vitest";
import { getRestoreApiSpecConfirmation } from "./ops";

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status },
    data,
  });
}

describe("getRestoreApiSpecConfirmation", () => {
  it("recognizes the exact typed 409 response", () => {
    expect(
      getRestoreApiSpecConfirmation(
        httpError(409, {
          error: "restore would delete API specs",
          api_specs_at_risk: 7,
          confirmation_required: "confirm_api_spec_deletion=true",
        }),
      ),
    ).toEqual({
      error: "restore would delete API specs",
      api_specs_at_risk: 7,
      confirmation_required: "confirm_api_spec_deletion=true",
    });
  });

  it.each([
    [400, { error: "x", api_specs_at_risk: 1, confirmation_required: "confirm_api_spec_deletion=true" }],
    [409, { error: "x", api_specs_at_risk: -1, confirmation_required: "confirm_api_spec_deletion=true" }],
    [409, { error: "x", api_specs_at_risk: 1.5, confirmation_required: "confirm_api_spec_deletion=true" }],
    [409, { error: "x", api_specs_at_risk: 1, confirmation_required: "confirm=true" }],
    [409, { error: "x", api_specs_at_risk: 1, confirmation_required: "confirm_api_spec_deletion=true", extra: true }],
    [409, { error: "ordinary conflict" }],
  ])("rejects non-canonical response %#", (status, data) => {
    expect(getRestoreApiSpecConfirmation(httpError(status, data))).toBeNull();
  });
});
