import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyConcurrentEditContract } from "./concurrent-edit-contract.mjs";

for (const etag of [null, "", 'W/"r1"', '""', "unquoted", '"r1", "r2"', '"r1"\n']) {
  test(`contract refusal for initial verification tag: ${JSON.stringify(etag)}`, async () => {
    const methods = [];
    let stored;
    let reads = 0;
    const exchange = async (_path, options = {}) => {
      const method = options.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        stored = options.body;
        return { status: 201, body: stored };
      }
      if (method === "GET") {
        reads += 1;
        // A valid editor seed cannot authorize an untagged verification read.
        return { status: 200, body: stored, etag: reads === 1 ? '"seed-token"' : etag };
      }
      return { status: 204 };
    };

    await assert.rejects(
      verifyConcurrentEditContract(exchange, { backend_scheme: "http", backend_port: 8080 }),
      /administrator 1 was refused unexpectedly/,
    );
    assert.deepEqual(methods, ["POST", "GET", "GET", "DELETE", "DELETE"]);
    assert.equal(stored.backend_read_timeout_ms, 5_000);
    assert.equal(stored.backend_host, "backend-a.contract.invalid");
  });
}
