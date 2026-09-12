import { describe, expect, it } from "vitest";
import {
  DEFAULT_BFF_PORT,
  DEFAULT_DEV_PORT,
  resolveViteDevServer,
} from "./viteDevServer";

describe("resolveViteDevServer", () => {
  it("keeps the current listen port and BFF proxy target when env is unset", () => {
    expect(resolveViteDevServer({})).toEqual({
      port: DEFAULT_DEV_PORT,
      proxyTarget: `http://localhost:${DEFAULT_BFF_PORT}`,
    });
  });

  it("treats blank values as unset", () => {
    expect(
      resolveViteDevServer({
        VITE_DEV_PORT: "  ",
        VITE_BFF_URL: "",
        PORT: "\t",
      }),
    ).toEqual({
      port: DEFAULT_DEV_PORT,
      proxyTarget: `http://localhost:${DEFAULT_BFF_PORT}`,
    });
  });

  it("reads VITE_DEV_PORT and follows PORT when VITE_BFF_URL is unset", () => {
    expect(
      resolveViteDevServer({ VITE_DEV_PORT: "5174", PORT: "3002" }),
    ).toEqual({
      port: 5174,
      proxyTarget: "http://localhost:3002",
    });
  });

  it("lets an explicit VITE_BFF_URL win over PORT", () => {
    expect(
      resolveViteDevServer({
        PORT: "3002",
        VITE_BFF_URL: "http://127.0.0.1:8787",
      }),
    ).toEqual({
      port: DEFAULT_DEV_PORT,
      proxyTarget: "http://127.0.0.1:8787",
    });
  });

  it("normalizes a trailing slash on VITE_BFF_URL to the origin", () => {
    expect(
      resolveViteDevServer({ VITE_BFF_URL: " https://bff.example.test:8443/ " }),
    ).toEqual({
      port: DEFAULT_DEV_PORT,
      proxyTarget: "https://bff.example.test:8443",
    });
  });

  it("rejects a non-integer or out-of-range VITE_DEV_PORT", () => {
    for (const value of ["NaN", "1.5", "-1", "0", "65536", "Infinity"]) {
      expect(() => resolveViteDevServer({ VITE_DEV_PORT: value })).toThrow(
        /VITE_DEV_PORT/,
      );
    }
  });

  it("rejects a non-integer or out-of-range PORT used as the default proxy port", () => {
    for (const value of ["soon", "70000"]) {
      expect(() => resolveViteDevServer({ PORT: value })).toThrow(/PORT/);
    }
  });

  it("does not consult PORT when VITE_BFF_URL is set", () => {
    expect(
      resolveViteDevServer({
        PORT: "not-a-port",
        VITE_BFF_URL: "http://localhost:3002",
      }),
    ).toEqual({
      port: DEFAULT_DEV_PORT,
      proxyTarget: "http://localhost:3002",
    });
  });

  it("rejects an unsafe or malformed VITE_BFF_URL", () => {
    for (const url of [
      "not-a-url",
      "ftp://localhost:3001",
      "http://user:pass@localhost:3001",
      "http://localhost:3001/api",
      "http://localhost:3001?x=1",
      "http://localhost:3001#frag",
    ]) {
      expect(() => resolveViteDevServer({ VITE_BFF_URL: url })).toThrow(
        /VITE_BFF_URL/,
      );
    }
  });
});
