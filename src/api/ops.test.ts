import { describe, expect, it } from "vitest";
import { getRestoreApiSpecConfirmation, getRestoreFailure } from "./ops";

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status },
    data,
  });
}

describe("getRestoreApiSpecConfirmation", () => {
  it("recognizes the required typed 409 fields and tolerates additive metadata", () => {
    expect(
      getRestoreApiSpecConfirmation(
        httpError(409, {
          error: "restore would delete API specs",
          api_specs_at_risk: 7,
          confirmation_required: "confirm_api_spec_deletion=true",
          request_id: "request-1",
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
    [409, { error: "ordinary conflict" }],
  ])("rejects non-canonical response %#", (status, data) => {
    expect(getRestoreApiSpecConfirmation(httpError(status, data))).toBeNull();
  });
});

describe("getRestoreFailure", () => {
  it.each(["completed", "incomplete", "not_needed", "unknown_outcome"] as const)(
    "preserves a %s rollback outcome and recovery details",
    (rollback) => {
      expect(getRestoreFailure(httpError(500, {
        error: "restore failed",
        restore_errors: ["proxy import failed"],
        rollback,
        rollback_errors: rollback === "incomplete" ? ["spec replay failed"] : [],
        api_specs_not_restored: rollback === "incomplete" ? 12 : 0,
        api_specs_note: "Verify the API spec inventory",
        request_id: "additive-field",
      }))).toEqual({
        error: "restore failed",
        restore_errors: ["proxy import failed"],
        rollback,
        rollback_errors: rollback === "incomplete" ? ["spec replay failed"] : [],
        api_specs_not_restored: rollback === "incomplete" ? 12 : 0,
        api_specs_note: "Verify the API spec inventory",
      });
    },
  );

  it("recognizes a pre-delete data-integrity failure", () => {
    expect(getRestoreFailure(httpError(500, {
      error: "stored resource could not be decoded",
      failure_class: "data_integrity",
      restore_errors: ["proxy/proxy-1"],
    }))).toEqual({
      error: "stored resource could not be decoded",
      failure_class: "data_integrity",
      restore_errors: ["proxy/proxy-1"],
    });
  });

  it.each([
    [400, { error: "restore failed", rollback: "incomplete" }],
    [500, { error: "restore failed", rollback: "maybe" }],
    [500, { error: "restore failed", rollback_errors: [1] }],
    [500, { error: "restore failed", api_specs_not_restored: -1 }],
  ])("rejects a noncanonical failure response %#", (status, data) => {
    expect(getRestoreFailure(httpError(status, data))).toBeNull();
  });
});
