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

const STILL_PENDING_PATTERN = /still pending/;
const DOES_NOT_MATCH_PATTERN = /does not match/;
const COMPLETED_AND_SUCCESSFUL_PATTERN = /completed and successful/;
const SUCCESSFUL_CURRENT_ATTEMPT_JOB_PATTERN = /successful current-attempt job/;
const INCOMPLETE_PATTERN = /incomplete/;
const SOURCE_COMMIT_PATTERN = /source [0-9a-f]{40}/;
const BASE_COMMIT_PATTERN = /base [0-9a-f]{40}/;
const PARENTHESIZED_COMMIT_PATTERN = /\([0-9a-f]{40};/;
const IMMUTABLE_SOURCE_BINDING_TESTED_PR_PATTERN = /immutable source binding|tested PR merge/;
const CHANGED_AFTER_HOSTED_QUALIFICATION_PATTERN = /changed after hosted qualification/;
const LAST_CHARACTER_PATTERN = /.$/;
const ONLY_QUALIFICATION_EVIDENCE_PATTERN = /Only qualification evidence/;
const TESTED_PR_MERGE_PATTERN = /tested PR merge/;
const NOT_AN_ANCESTOR_PATTERN = /not an ancestor/;
const SOURCE_TREES_ONLY_QUALIFICATION_EVIDENCE_PATTERN = /source trees|Only qualification evidence/;
const REQUIRES_HOSTED_GITHUB_ACTIONS_PATTERN = /requires hosted GitHub Actions/;
const INCOMPLETE_OR_UNREADABLE_QUALIFICATION_PATTERN =
  /incomplete qualification jobs|unreadable qualification record/;
const CHANGED_DURING_VERIFICATION_PATTERN = /changed during verification/;

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
  it("accepts an evidence commit after the PR and main advance beyond the tested merge", () => {
    const { record, evidence } = fixture();
    assert.equal(evidence.run.pull_requests[0].head.sha, evidence.target.commit.sha);
    assert.notEqual(evidence.run.pull_requests[0].head.sha, evidence.run.head_sha);
    assert.notEqual(evidence.run.pull_requests[0].base.sha, evidence.tested.commit.parents[0].sha);
    assert.deepEqual(qualificationErrors(record.qualification), []);
    assert.doesNotThrow(() => requireHostedQualification(record, evidence));
  });

  it("uses the original producer binding throughout the evidence-recording lifecycle", () => {
    const { record, evidence } = fixture();
    const pr = evidence.run.pull_requests[0];
    pr.head.sha = evidence.source.commit.sha;
    pr.base.sha = evidence.tested.commit.parents[0].sha;
    const originalJob = structuredClone(evidence.jobs.jobs.at(-1));
    assert.doesNotThrow(() => requireHostedQualification(record, evidence));

    pr.head.sha = evidence.target.commit.sha;
    pr.base.sha = "8".repeat(40);
    assert.deepEqual(evidence.jobs.jobs.at(-1), originalJob);
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
    assert.throws(() => requireHostedQualification(record, evidence), STILL_PENDING_PATTERN);
  });

  it("also accepts a successful main-push source followed by evidence recording", () => {
    const { record, evidence } = fixture();
    record.qualification.tested_commit = record.qualification.source_commit;
    evidence.run.event = "push";
    evidence.run.head_branch = "main";
    evidence.tested = structuredClone(evidence.source);
    const sha = record.qualification.source_commit;
    evidence.jobs.jobs.at(-1).name =
      `Qualification Source (${sha}; source ${sha}; base ${sha}; ref main)`;
    evidence.target.record = structuredClone(record);
    assert.doesNotThrow(() => requireHostedQualification(record, evidence));
  });

  it("refuses URL-only, old, failed, pending and nonexistent evidence", () => {
    const { record, evidence } = fixture();
    assert.throws(() => requireHostedQualification(record), DOES_NOT_MATCH_PATTERN);
    const old = structuredClone(record);
    old.qualification.ci_evidence =
      "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153";
    assert.throws(() => requireHostedQualification(old, evidence), DOES_NOT_MATCH_PATTERN);
    for (const update of [
      { status: "completed", conclusion: "failure" },
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "cancelled" },
    ]) {
      const changed = structuredClone(evidence);
      Object.assign(changed.run, update);
      assert.throws(() => requireHostedQualification(record, changed), COMPLETED_AND_SUCCESSFUL_PATTERN);
    }
    for (const field of ["source_commit", "tested_commit", "run_attempt"]) {
      const incomplete = structuredClone(record);
      delete incomplete.qualification[field];
      assert.throws(() => requireHostedQualification(incomplete, evidence), STILL_PENDING_PATTERN);
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
      assert.throws(() => requireHostedQualification(record, evidence), DOES_NOT_MATCH_PATTERN);
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
          SUCCESSFUL_CURRENT_ATTEMPT_JOB_PATTERN,
        );
      }
      const missing = structuredClone(evidence);
      missing.jobs.jobs.splice(index, 1);
      missing.jobs.total_count -= 1;
      assert.throws(
        () => requireHostedQualification(record, missing),
        SUCCESSFUL_CURRENT_ATTEMPT_JOB_PATTERN,
      );
    }
    const duplicate = structuredClone(evidence);
    duplicate.jobs.jobs.push(duplicate.jobs.jobs[0]);
    duplicate.jobs.total_count += 1;
    assert.throws(
      () => requireHostedQualification(record, duplicate),
      SUCCESSFUL_CURRENT_ATTEMPT_JOB_PATTERN,
    );
    const partial = structuredClone(evidence);
    partial.jobs.total_count += 1;
    assert.throws(() => requireHostedQualification(record, partial), INCOMPLETE_PATTERN);
  });

  it("rejects wrong producer source, base, tested commit, target ref and legacy bindings", () => {
    for (const change of [
      (name) => name.replace(SOURCE_COMMIT_PATTERN, `source ${"9".repeat(40)}`),
      (name) => name.replace(BASE_COMMIT_PATTERN, `base ${"9".repeat(40)}`),
      (name) => name.replace(PARENTHESIZED_COMMIT_PATTERN, `(${"9".repeat(40)};`),
      (name) => name.replace("ref main", "ref other"),
      () => `Qualification Source (${"b".repeat(40)})`,
    ]) {
      const { record, evidence } = fixture();
      evidence.jobs.jobs.at(-1).name = change(evidence.jobs.jobs.at(-1).name);
      assert.throws(
        () => requireHostedQualification(record, evidence),
        IMMUTABLE_SOURCE_BINDING_TESTED_PR_PATTERN,
      );
    }
  });

  it("rejects an intervening source edit even when the live PR head names the evidence commit", () => {
    const { record, evidence } = fixture();
    evidence.target.commit.parents = [{ sha: "7".repeat(40) }];
    evidence.target.tree.tree.find((entry) => entry.path === "package.json").sha = "9".repeat(40);
    assert.equal(evidence.run.pull_requests[0].head.sha, evidence.target.commit.sha);
    assert.throws(
      () => requireHostedQualification(record, evidence),
      CHANGED_AFTER_HOSTED_QUALIFICATION_PATTERN,
    );
  });

  it("rejects code, canonical pin, workflow and pairing changes after qualification", () => {
    const paths = ["package.json", "contracts/ferrum-contracts/PIN", ".github/workflows/ci.yml"];
    for (const path of paths) {
      const { record, evidence } = fixture();
      evidence.target.tree.tree.find((entry) => entry.path === path).sha = "9".repeat(40);
      assert.throws(
        () => requireHostedQualification(record, evidence),
        CHANGED_AFTER_HOSTED_QUALIFICATION_PATTERN,
      );
    }
    for (const mutate of [
      (r) => {
        r.edge.image = r.edge.image.replace(LAST_CHARACTER_PATTERN, "f");
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
        ONLY_QUALIFICATION_EVIDENCE_PATTERN,
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
        e.tested.commit.parents[0].sha = "9".repeat(40);
      },
    ]) {
      const { record, evidence } = fixture();
      mutate(evidence);
      assert.throws(() => requireHostedQualification(record, evidence), TESTED_PR_MERGE_PATTERN);
    }
    const { record, evidence } = fixture();
    evidence.tested.tree.tree[1].sha = "9".repeat(40);
    assert.throws(
      () => requireHostedQualification(record, evidence),
      CHANGED_AFTER_HOSTED_QUALIFICATION_PATTERN,
    );
    const unrelated = fixture();
    unrelated.evidence.comparison.status = "diverged";
    assert.throws(
      () => requireHostedQualification(unrelated.record, unrelated.evidence),
      NOT_AN_ANCESTOR_PATTERN,
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
        SOURCE_TREES_ONLY_QUALIFICATION_EVIDENCE_PATTERN,
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
    evidence.jobs.jobs.at(-1).name =
      `Qualification Source (${selfSha}; source ${selfSha}; base ${selfSha}; ref main)`;
    assert.throws(() => requireHostedQualification(record, evidence), ONLY_QUALIFICATION_EVIDENCE_PATTERN);
  });
});

describe("hosted qualification API reader", () => {
  it("loads the exact run, attempt, trees and records through read-only API routes", async () => {
    const f = fixture();
    const evidence = await readHostedQualification(f.record, f.env, apiFixture(f));
    assert.deepEqual(evidence, f.evidence);
  });

  it("retains original checkout evidence on later job pages after the PR advances", async () => {
    const f = fixture();
    const required = structuredClone(f.evidence.jobs.jobs);
    const extra = Array.from({ length: 100 }, (_, index) => ({
      id: 100 + index,
      name: `Optional job ${index}`,
      run_id: 123,
      run_attempt: 1,
      head_sha: f.evidence.run.head_sha,
      status: "completed",
      conclusion: "skipped",
    }));
    f.evidence.jobs.jobs = [...extra, ...required];
    f.evidence.jobs.total_count = f.evidence.jobs.jobs.length;
    const read = apiFixture(f);
    const pages = [];
    const evidence = await readHostedQualification(f.record, f.env, async (path) => {
      if (!path.includes("/jobs?")) return read(path);
      pages.push(path);
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return {
        total_count: f.evidence.jobs.total_count,
        jobs: structuredClone(f.evidence.jobs.jobs.slice((page - 1) * 100, page * 100)),
      };
    });
    assert.deepEqual(pages, [
      "actions/runs/123/attempts/1/jobs?per_page=100&page=1",
      "actions/runs/123/attempts/1/jobs?per_page=100&page=2",
    ]);
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
        REQUIRES_HOSTED_GITHUB_ACTIONS_PATTERN,
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
        INCOMPLETE_OR_UNREADABLE_QUALIFICATION_PATTERN,
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
      CHANGED_DURING_VERIFICATION_PATTERN,
    );
  });
});
