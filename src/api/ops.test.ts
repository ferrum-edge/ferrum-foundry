import { describe, expect, it } from "vitest";
import {
  getRestoreApiSpecConfirmation,
  getRestoreFailure,
  getRestoreCommitted,
  getRestoreUnknownOutcome,
} from "./ops";

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


describe("restore 503 recovery", () => {
  it("preserves connectivity errors without claiming a rollback", () => {
    const body = { error: "database unreachable", failure_class: "connectivity", restore_errors: ["snapshot failed"] };
    expect(getRestoreFailure(httpError(503, body))).toEqual(body);
    expect(getRestoreCommitted(httpError(503, body))).toBeNull();
  });

  it.each([undefined, "not JSON", {}, { applied: "false" }])("recognizes a valid cursor independent of body %j", (data) => {
    const error = Object.assign(httpError(503, data), {
      response: { status: 503, headers: new Headers({ "x-ferrum-config-cursor": "1:2" }) },
    });
    expect(getRestoreCommitted(error)).toEqual({ cursor: "1:2", reason: null });
    expect(getRestoreFailure(error)).toBeNull();
  });

  it("recognizes an explicit commit without a cursor", () => {
    const error = httpError(503, { error: "reload timed out", applied: false, reason: "reload_timeout" });
    expect(getRestoreCommitted(error)).toEqual({ cursor: null, reason: "reload_timeout" });
    expect(getRestoreFailure(error)).toBeNull();
  });

  it.each(["not-a-cursor", "18446744073709551616:2"])("does not infer a commit from invalid cursor %s", (cursor) => {
    const error = Object.assign(httpError(503, {}), {
      response: { status: 503, headers: new Headers({ "x-ferrum-config-cursor": cursor }) },
    });
    expect(getRestoreCommitted(error)).toBeNull();
  });
});

describe("getRestoreUnknownOutcome", () => {
  const unobservable: Array<[number, Record<string, unknown> & { error: string }, string]> = [
    [504, { error: "Gateway Timeout", code: "FERRUM_BFF_TIMEOUT", phase: "response" }, "gateway_timeout"],
    [504, { error: "Gateway Timeout" }, "gateway_timeout"],
    [502, { error: "Bad Gateway", code: "FERRUM_BFF_UPSTREAM_FAILURE" }, "upstream_failure"],
  ];

  it.each(unobservable)("treats %d as unobservable", (status, data, reason) => {
    expect(getRestoreUnknownOutcome(httpError(status, data))).toEqual({
      reason,
      detail: data.error,
    });
  });

  it("keeps an upload-phase timeout a definite, retryable failure", () => {
    const error = httpError(504, {
      error: "Gateway Timeout", code: "FERRUM_BFF_TIMEOUT", phase: "upload", reason: "idle",
    });
    expect(getRestoreUnknownOutcome(error)).toBeNull();
  });

  it("classifies a client timeout and a dropped connection", () => {
    const timeout = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    expect(getRestoreUnknownOutcome(timeout)).toEqual({ reason: "client_timeout", detail: null });
    expect(getRestoreUnknownOutcome(new TypeError("Failed to fetch"))).toEqual({
      reason: "transport",
      detail: "Failed to fetch",
    });
  });

  it("leaves gateway answers and pre-send refusals to their own classifiers", () => {
    const unbound = Object.assign(new Error("no namespace binding"), {
      name: "UnboundNamespaceError",
    });
    expect(getRestoreUnknownOutcome(unbound)).toBeNull();
    expect(getRestoreUnknownOutcome(httpError(500, { error: "restore failed" }))).toBeNull();
    expect(getRestoreUnknownOutcome(httpError(503, { error: "database unreachable" }))).toBeNull();
    expect(getRestoreUnknownOutcome(httpError(409, { error: "specs at risk" }))).toBeNull();
    expect(getRestoreUnknownOutcome("not an error")).toBeNull();
  });
});
