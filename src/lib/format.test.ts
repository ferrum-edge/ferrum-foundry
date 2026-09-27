import { describe, expect, it } from "vitest";
import {
  EMPTY_VALUE,
  formatDateTime,
  formatTime,
  humanizeKey,
  isIsoTimestamp,
  isoDateTime,
} from "./format";

const STAMP = "2026-09-25T20:40:00Z";

describe("date and time formatting", () => {
  it("renders every accepted input shape the same way", () => {
    const expected = formatDateTime(STAMP);
    expect(expected).toMatch(/2026/);
    expect(formatDateTime(Date.parse(STAMP))).toBe(expected);
    expect(formatDateTime(new Date(STAMP))).toBe(expected);
  });

  it("omits seconds from a date-time and keeps them for a time of day", () => {
    const at = "2026-09-25T20:40:37Z";
    expect(formatDateTime(at)).not.toContain("37");
    expect(formatTime(at)).toContain("37");
    expect(formatTime(at)).not.toContain("2026");
  });

  it.each([undefined, null, "", "not a date", Number.NaN])(
    "renders the fallback for %s instead of Invalid Date",
    (value) => {
      expect(formatDateTime(value)).toBe(EMPTY_VALUE);
      expect(formatTime(value)).toBe(EMPTY_VALUE);
      expect(formatDateTime(value, "never")).toBe("never");
      expect(isoDateTime(value)).toBeUndefined();
    },
  );

  it("recognises only full gateway timestamps as ISO", () => {
    expect(isIsoTimestamp("2026-09-27T10:00:50.528Z")).toBe(true);
    expect(isIsoTimestamp("2026-09-27T10:00:50+02:00")).toBe(true);
    expect(isIsoTimestamp("2026-09-27")).toBe(false);
    expect(isIsoTimestamp("database")).toBe(false);
    expect(isIsoTimestamp(1_788_220_800_000)).toBe(false);
  });
});

describe("humanizeKey", () => {
  it.each([
    ["mtls_credentials", "mTLS credentials"],
    ["jwt_credentials", "JWT credentials"],
    ["key_auth_credentials", "Key auth credentials"],
    ["config_generation", "Config generation"],
    ["build_capable", "Build capable"],
    ["cp_authority", "CP authority"],
    ["inbound_tls_failure", "Inbound TLS failure"],
    ["grpc_method_router", "gRPC method router"],
    ["last_poll_completed_at", "Last poll completed at"],
    ["hbone", "HBONE"],
  ])("labels %s as %s", (key, label) => {
    expect(humanizeKey(key)).toBe(label);
  });
});
