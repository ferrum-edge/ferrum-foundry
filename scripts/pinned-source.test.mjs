import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPinnedSource, pinnedSourceUrl } from "./pinned-source.mjs";
import { PLUGIN_SCHEMA_SPEC } from "../src/lib/pluginSchemas.ts";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";

const SOURCE = { repository: "ferrum-edge/ferrum-edge", path: "openapi.yaml" };
const REF = "0123456789abcdef0123456789abcdef01234567";
const URL_FOR_REF = `https://raw.githubusercontent.com/ferrum-edge/ferrum-edge/${REF}/openapi.yaml`;

function harness(answers) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, options: { fetchImpl, sleep } };
}

const ok = (text) => new Response(text, { status: 200 });

test("fetches the raw file at the ref with a per-attempt deadline", async () => {
  const { calls, sleeps, options } = harness([ok("spec")]);
  assert.equal(await fetchPinnedSource(SOURCE, REF, options), "spec");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_FOR_REF);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(sleeps, []);
});

test("each drift check names its own source", () => {
  assert.equal(
    pinnedSourceUrl(PLUGIN_SCHEMA_SPEC, "main"),
    `https://raw.githubusercontent.com/${PLUGIN_SCHEMA_SPEC.repository}/main/${PLUGIN_SCHEMA_SPEC.path}`,
  );
  assert.equal(
    pinnedSourceUrl(PLUGIN_SENSITIVITY_SOURCE, "main"),
    `https://raw.githubusercontent.com/${PLUGIN_SENSITIVITY_SOURCE.repository}/main/${PLUGIN_SENSITIVITY_SOURCE.path}`,
  );
  assert.notEqual(PLUGIN_SCHEMA_SPEC.path, PLUGIN_SENSITIVITY_SOURCE.path);
});

test("retries a transport failure with linear backoff, then succeeds", async () => {
  const { calls, sleeps, options } = harness([
    new TypeError("fetch failed"),
    new Error("read ECONNRESET"),
    ok("spec"),
  ]);
  assert.equal(await fetchPinnedSource(SOURCE, REF, options), "spec");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2_000, 4_000]);
});

test("gives up after four transport failures without passing", async () => {
  const { calls, sleeps, options } = harness([
    new Error("getaddrinfo EAI_AGAIN raw.githubusercontent.com"),
    new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com"),
    new Error("connect ETIMEDOUT"),
    new Error("socket hang up"),
  ]);
  await assert.rejects(
    fetchPinnedSource(SOURCE, REF, options),
    { message: `Could not fetch ${URL_FOR_REF}: socket hang up` },
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [2_000, 4_000, 6_000], "no backoff after the last attempt");
});

test("an HTTP error is fatal on the first attempt", async () => {
  const { calls, sleeps, options } = harness([new Response("missing", { status: 404 })]);
  await assert.rejects(
    fetchPinnedSource(SOURCE, REF, options),
    { message: `${URL_FOR_REF} returned 404` },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("an error that is not a transport failure is not retried", async () => {
  // Includes the per-attempt deadline's TimeoutError, whose message names no
  // transport failure.
  for (const error of [
    new TypeError("Invalid URL"),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  ]) {
    const { calls, options } = harness([error, ok("spec")]);
    await assert.rejects(fetchPinnedSource(SOURCE, REF, options), error);
    assert.equal(calls.length, 1);
  }
});
