import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUALIFICATION_RECORD,
  githubQualificationReader,
  qualificationErrors,
  readHostedQualification,
  requireHostedQualification,
} from "./hosted-qualification.mjs";
import { hostedQualificationFixture } from "./fixtures/hosted-qualification.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";

const base = readSupportedPairing();
const fixture = () => hostedQualificationFixture(base);

/** Static GitHub API responses; no real credentials, git or network calls. */
function apiFixture({ evidence }) {
  const routes = new Map([
    ["actions/runs/123", evidence.run],
    ["actions/workflows/ci.yml", evidence.workflow],
    ["actions/runs/123/attempts/1/jobs?per_page=100&page=1", evidence.jobs],
    [`compare/${evidence.source.commit.sha}...${evidence.target.commit.sha}`, evidence.comparison],
  ]);
  for (const snapshot of [evidence.source, evidence.tested, evidence.target]) {
    routes.set(`git/commits/${snapshot.commit.sha}`, snapshot.commit);
    routes.set(`git/trees/${snapshot.tree.sha}?recursive=1`, snapshot.tree);
    const sha = snapshot.tree.tree.find((entry) => entry.path === QUALIFICATION_RECORD).sha;
    const bytes = Buffer.from(JSON.stringify(snapshot.record));
    routes.set(`git/blobs/${sha}`, {
      sha,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    });
  }
  return async (path) => {
    assert.ok(routes.has(path), `unexpected API route: ${path}`);
    return structuredClone(routes.get(path));
  };
}

describe("hosted qualification binding", () => {
  it("accepts a successful PR tree followed only by its evidence record and a merge", () => {
    const { record, evidence } = fixture();
    assert.deepEqual(qualificationErrors(record.qualification), []);
    assert.doesNotThrow(() => requireHostedQualification(record, evidence));
  });

  it("keeps pending evidence null and refuses extra qualification fields", () => {
    const { record, evidence } = fixture();
    assert.deepEqual(qualificationErrors(evidence.source.record.qualification), []);
    for (const field of ["ci_evidence", "source_commit", "tested_commit", "run_attempt"]) {
      const pending = structuredClone(evidence.source.record.qualification);
      pending[field] = record.qualification[field];
      assert.ok(qualificationErrors(pending).some((error) => error.includes(field)));
    }
    record.qualification.extra = "unreviewed";
    assert.throws(() => requireHostedQualification(record, evidence), /still pending/);
  });

  it("also accepts a successful main-push source followed by evidence recording", () => {
    const { record, evidence } = fixture();
    record.qualification.tested_commit = record.qualification.source_commit;
    evidence.run.event = "push";
    evidence.run.head_branch = "main";
    evidence.tested = structuredClone(evidence.source);
    evidence.jobs.jobs.at(-1).name = `Qualification Source (${record.qualification.tested_commit})`;
    evidence.target.record = structuredClone(record);
    assert.doesNotThrow(() => requireHostedQualification(record, evidence));
  });

  it("refuses URL-only, old, failed, pending and nonexistent evidence", () => {
    const { record, evidence } = fixture();
    assert.throws(() => requireHostedQualification(record), /does not match/);
    const old = structuredClone(record);
    old.qualification.ci_evidence =
      "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153";
    assert.throws(() => requireHostedQualification(old, evidence), /does not match/);
    for (const update of [
      { status: "completed", conclusion: "failure" },
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "cancelled" },
    ]) {
      const changed = structuredClone(evidence);
      Object.assign(changed.run, update);
      assert.throws(() => requireHostedQualification(record, changed), /completed and successful/);
    }
    for (const field of ["source_commit", "tested_commit", "run_attempt"]) {
      const incomplete = structuredClone(record);
      delete incomplete.qualification[field];
      assert.throws(() => requireHostedQualification(incomplete, evidence), /still pending/);
    }
  });

  it("refuses a different repository, workflow, head or attempt", () => {
    for (const mutate of [
      (e) => {
        e.run.repository.full_name = "elsewhere/repo";
      },
      (e) => {
        e.run.head_repository.full_name = "elsewhere/repo";
      },
      (e) => {
        e.run.path = ".github/workflows/unrelated.yml";
      },
      (e) => {
        e.run.workflow_id += 1;
      },
      (e) => {
        e.run.head_sha = "9".repeat(40);
      },
      (e) => {
        e.run.run_attempt += 1;
      },
    ]) {
      const { record, evidence } = fixture();
      mutate(evidence);
      assert.throws(() => requireHostedQualification(record, evidence), /does not match/);
    }
  });

  it("requires every pairing job, completed successfully in the recorded attempt", () => {
    const { record, evidence } = fixture();
    for (let index = 0; index < evidence.jobs.jobs.length; index += 1) {
      for (const change of [
        { status: "in_progress", conclusion: null },
        { conclusion: "failure" },
        { conclusion: "skipped" },
        { run_attempt: 2 },
        { head_sha: "9".repeat(40) },
        { run_id: 456 },
      ]) {
        const changed = structuredClone(evidence);
        Object.assign(changed.jobs.jobs[index], change);
        assert.throws(
          () => requireHostedQualification(record, changed),
          /successful current-attempt job/,
        );
      }
      const missing = structuredClone(evidence);
      missing.jobs.jobs.splice(index, 1);
      missing.jobs.total_count -= 1;
      assert.throws(
        () => requireHostedQualification(record, missing),
        /successful current-attempt job/,
      );
    }
    const duplicate = structuredClone(evidence);
    duplicate.jobs.jobs.push(duplicate.jobs.jobs[0]);
    duplicate.jobs.total_count += 1;
    assert.throws(
      () => requireHostedQualification(record, duplicate),
      /successful current-attempt job/,
    );
    const partial = structuredClone(evidence);
    partial.jobs.total_count += 1;
    assert.throws(() => requireHostedQualification(record, partial), /incomplete/);
  });

  it("rejects code, canonical pin, workflow and pairing changes after qualification", () => {
    const paths = ["package.json", "contracts/ferrum-contracts/PIN", ".github/workflows/ci.yml"];
    for (const path of paths) {
      const { record, evidence } = fixture();
      evidence.target.tree.tree.find((entry) => entry.path === path).sha = "9".repeat(40);
      assert.throws(
        () => requireHostedQualification(record, evidence),
        /changed after hosted qualification/,
      );
    }
    for (const mutate of [
      (r) => {
        r.edge.image = r.edge.image.replace(/.$/, "f");
      },
      (r) => {
        r.edge.source_commit = "9".repeat(40);
      },
      (r) => {
        r.tested.roles = ["admin"];
      },
      (r) => {
        r.foundry.version = "9.9.9";
      },
    ]) {
      const { record, evidence } = fixture();
      mutate(record);
      evidence.target.record = structuredClone(record);
      assert.throws(
        () => requireHostedQualification(record, evidence),
        /Only qualification evidence/,
      );
    }
  });

  it("refuses a different tested merge, merge-only changes and unrelated release ancestry", () => {
    for (const mutate of [
      (e) => {
        e.tested.commit.parents[1].sha = "9".repeat(40);
      },
      (e) => {
        e.tested.commit.parents.reverse();
      },
      (e) => {
        e.run.pull_requests[0].base.sha = "9".repeat(40);
      },
    ]) {
      const { record, evidence } = fixture();
      mutate(evidence);
      assert.throws(() => requireHostedQualification(record, evidence), /tested PR merge/);
    }
    const { record, evidence } = fixture();
    evidence.tested.tree.tree[1].sha = "9".repeat(40);
    assert.throws(
      () => requireHostedQualification(record, evidence),
      /changed after hosted qualification/,
    );
    const unrelated = fixture();
    unrelated.evidence.comparison.status = "diverged";
    assert.throws(
      () => requireHostedQualification(unrelated.record, unrelated.evidence),
      /not an ancestor/,
    );
  });

  it("rejects truncated trees, changed record fields and circular source claims", () => {
    for (const mutate of [
      (e) => {
        e.target.tree.truncated = true;
      },
      (e) => {
        e.target.tree.sha = "9".repeat(40);
      },
      (e) => {
        e.source.record.qualification.status = "qualified";
      },
      (e) => {
        e.target.record.edge.release.version = "v9.9.9";
      },
    ]) {
      const { record, evidence } = fixture();
      mutate(evidence);
      assert.throws(
        () => requireHostedQualification(record, evidence),
        /source trees|Only qualification evidence/,
      );
    }
    const { record, evidence } = fixture();
    const selfSha = evidence.target.commit.sha;
    Object.assign(record.qualification, { source_commit: selfSha, tested_commit: selfSha });
    Object.assign(evidence.run, { event: "push", head_branch: "main", head_sha: selfSha });
    evidence.target.record = structuredClone(record);
    evidence.source = structuredClone(evidence.target);
    evidence.tested = structuredClone(evidence.target);
    for (const job of evidence.jobs.jobs) job.head_sha = selfSha;
    evidence.jobs.jobs.at(-1).name = `Qualification Source (${selfSha})`;
    assert.throws(() => requireHostedQualification(record, evidence), /Only qualification evidence/);
  });
});

describe("hosted qualification API reader", () => {
  it("loads the exact run, attempt, trees and records through read-only API routes", async () => {
    const f = fixture();
    const evidence = await readHostedQualification(f.record, f.env, apiFixture(f));
    assert.deepEqual(evidence, f.evidence);
  });

  it("fails closed outside the hosted repository or without token/source identity", async () => {
    const f = fixture();
    for (const change of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_REPOSITORY: "elsewhere/repo" },
      { GH_TOKEN: "" },
      { GITHUB_SHA: "main" },
    ]) {
      await assert.rejects(
        readHostedQualification(f.record, { ...f.env, ...change }, apiFixture(f)),
        /requires hosted GitHub Actions/,
      );
    }
  });

  it("redacts API and transport failures without retaining causes", async () => {
    for (const fetchImpl of [
      async () => ({ ok: false, status: 404 }),
      async () => ({ ok: false, status: 403 }),
      async () => {
        throw new Error("transport fixture-token and response-secret");
      },
      async () => {
        throw new DOMException("fixture-token", "TimeoutError");
      },
      async () => ({
        ok: true,
        json: async () => {
          throw new Error("response-secret");
        },
      }),
    ]) {
      const f = fixture();
      await assert.rejects(
        readHostedQualification(
          f.record,
          f.env,
          githubQualificationReader("fixture-token", fetchImpl),
        ),
        (error) => {
          assert.equal(
            error.message,
            "Could not read hosted qualification evidence from GitHub; release refused",
          );
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }
    const read = githubQualificationReader("fixture-token", async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/ferrum-edge/ferrum-foundry/actions/runs/123");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ id: 123 }) };
    });
    assert.deepEqual(await read("actions/runs/123"), { id: 123 });
  });

  it("rejects incomplete job pages, corrupt record blobs and a concurrent rerun", async () => {
    for (const mutate of [
      (path, value) => {
        if (path.includes("/jobs?")) value.total_count += 1;
      },
      (path, value) => {
        if (path.startsWith("git/blobs/")) value.size += 1;
      },
    ]) {
      const f = fixture();
      const read = apiFixture(f);
      await assert.rejects(
        readHostedQualification(f.record, f.env, async (path) => {
          const value = await read(path);
          mutate(path, value);
          return value;
        }),
        /incomplete qualification jobs|unreadable qualification record/,
      );
    }
    const f = fixture();
    const read = apiFixture(f);
    let runs = 0;
    await assert.rejects(
      readHostedQualification(f.record, f.env, async (path) => {
        const value = await read(path);
        if (path === "actions/runs/123" && ++runs === 2) value.run_attempt += 1;
        return value;
      }),
      /changed during verification/,
    );
  });
});
