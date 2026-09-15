import assert from "node:assert/strict";

/** Hosted disposable-gateway check only; never used to infer UI access. */
export async function verifyBasicAuthContract(exchange) {
  const id = "contract-smoke-basic-auth";
  const path = `/consumers/${id}`;
  const credentialsPath = `${path}/credentials/basicauth?apply=sync`;
  async function request(endpoint, options = {}, expected = [200, 201]) {
    const response = await exchange(endpoint, options);
    // Do not print backup material or password-bearing request/response bodies.
    assert.ok(expected.includes(response.status),
      `${options.method ?? "GET"} ${endpoint} returned ${response.status}`);
    return response.body;
  }
  function assertOmitted(consumer) {
    assert.ok(consumer && consumer.credentials, "ordinary Consumer must include credentials");
    assert.equal(Object.hasOwn(consumer.credentials, "basicauth"), false,
      "ordinary Consumer must omit basicauth even when passwords exist");
    assert.equal(consumer.credentials.keyauth?.length, 1, "preserve observable credential type");
    assert.equal(consumer.credentials.keyauth[0].key, "[REDACTED]");
  }
  async function storedCredentials() {
    const backup = await request("/backup");
    const consumer = backup.consumers.find((entry) => entry.id === id);
    assert.ok(consumer, "authenticated backup must contain the synthetic consumer");
    assert.equal(consumer.credentials.keyauth?.length, 1);
    return consumer.credentials;
  }
  function hashes(credentials, count) {
    const entries = credentials.basicauth;
    assert.equal(entries?.length, count, "backup must reflect basic rotation count");
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry), ["password_hash"], "backup must contain only canonical basic hashes");
      assert.ok(/^hmac_sha256:[0-9a-f]{64}$/.test(entry.password_hash), "canonical HMAC-SHA256 basic hash");
    }
    return entries.map((entry) => entry.password_hash);
  }

  try {
    assertOmitted(await request("/consumers?apply=sync", {
      method: "POST",
      body: {
        id, username: id,
        credentials: {
          keyauth: [{ key: "contract-basic-observable-control" }],
          basicauth: [{ password: "contract-basic-original-synthetic-password" }],
        },
      },
    }));
    assertOmitted(await request(path));
    const original = hashes(await storedCredentials(), 1);

    assertOmitted(await request(credentialsPath, {
      method: "POST", body: { password: "contract-basic-appended-synthetic-password" },
    }));
    const appended = hashes(await storedCredentials(), 2);
    assert.equal(appended[0], original[0], "append preserves the existing password");

    assertOmitted(await request(credentialsPath, {
      method: "PUT", body: { password: "contract-basic-replacement-synthetic-password" },
    }));
    assertOmitted(await request(path));
    const replaced = hashes(await storedCredentials(), 1);
    assert.ok(!appended.includes(replaced[0]), "replacement removes both previous passwords");

    await request(credentialsPath, { method: "DELETE" }, [200, 204]);
    assertOmitted(await request(path));
    const deleted = await storedCredentials();
    assert.equal(Object.hasOwn(deleted, "basicauth"), false, "type deletion removes all basic credentials");
    return { verified: true, operations: ["omission", "canonical backup", "append", "replace", "type delete"] };
  } finally {
    await request(`${path}?apply=sync`, { method: "DELETE" }, [200, 204, 404]);
  }
}
