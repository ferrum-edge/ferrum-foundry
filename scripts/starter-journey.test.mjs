import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmTarget, runIdentityBoundary } from "./starter-journey.mjs";

test("the journey rejects a confirmed 127-prefixed DNS target before its first request", async () => {
  let requests = 0;

  await assert.rejects(
    runIdentityBoundary({
      foundry: "http://127.0.0.1.gateway.example",
      namespace: "production",
      confirmation: "http://127.0.0.1.gateway.example#production",
      fetchImpl: async () => {
        requests += 1;
        return new Response("", { status: 401 });
      },
    }),
    /Refusing to send the proof secret/,
  );

  assert.equal(requests, 0, "the identity checks must not start for a rejected target");
});

test("the journey accepts confirmed HTTPS and genuine loopback targets", () => {
  for (const foundry of [
    "https://foundry.example.com",
    "http://127.0.0.1:8088",
    "http://[::1]:8088",
    "http://localhost:8088",
  ]) {
    confirmTarget(foundry, "production", `${foundry}#production`);
  }
});
