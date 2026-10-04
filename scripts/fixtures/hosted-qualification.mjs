import {
  QUALIFICATION_JOBS,
  QUALIFICATION_RECORD,
  QUALIFICATION_REPOSITORY,
  QUALIFICATION_WORKFLOW,
} from "../hosted-qualification.mjs";

/** Entirely fictitious hosted evidence, never a recorded release fact. */
export function hostedQualificationFixture(base) {
  const sourceSha = "a".repeat(40);
  const testedSha = "b".repeat(40);
  const targetSha = "c".repeat(40);
  const baseSha = "d".repeat(40);
  const record = structuredClone(base);
  record.status = "candidate";
  Object.assign(record.foundry, { source_commit: null, image: null, ci_evidence: null });
  record.qualification = {
    status: "qualified",
    ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    source_commit: sourceSha,
    tested_commit: testedSha,
    run_attempt: 1,
  };
  const pending = structuredClone(record);
  pending.qualification = {
    status: "pending",
    ci_evidence: null,
    source_commit: null,
    tested_commit: null,
    run_attempt: null,
  };
  function snapshot(sha, current = false, parents = []) {
    const treeSha = (current ? "e" : "f").repeat(40);
    return {
      commit: { sha, tree: { sha: treeSha }, parents: parents.map((sha) => ({ sha })) },
      tree: {
        sha: treeSha,
        truncated: false,
        tree: [
          { path: "docs", mode: "040000", type: "tree", sha: treeSha },
          ...["package.json", QUALIFICATION_WORKFLOW, "contracts/ferrum-contracts/PIN"].map(
            (path) => ({ path, mode: "100644", type: "blob", sha: "1".repeat(40) }),
          ),
          {
            path: QUALIFICATION_RECORD,
            mode: "100644",
            type: "blob",
            sha: (current ? "2" : "3").repeat(40),
          },
        ],
      },
      record: structuredClone(current ? record : pending),
    };
  }
  const run = {
    id: 123,
    workflow_id: 1,
    path: QUALIFICATION_WORKFLOW,
    event: "pull_request",
    repository: { id: 42, full_name: QUALIFICATION_REPOSITORY },
    head_repository: { id: 42, full_name: QUALIFICATION_REPOSITORY },
    head_sha: sourceSha,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    pull_requests: [
      {
        head: { sha: sourceSha, repo: { id: 42 } },
        base: { sha: baseSha, ref: "main", repo: { id: 42 } },
      },
    ],
  };
  const jobs = [...QUALIFICATION_JOBS, `Qualification Source (${testedSha})`].map(
    (name, index) => ({
      id: index + 1,
      name,
      run_id: run.id,
      run_attempt: 1,
      head_sha: sourceSha,
      status: "completed",
      conclusion: "success",
    }),
  );
  return {
    record,
    evidence: {
      run,
      workflow: { id: 1, path: QUALIFICATION_WORKFLOW },
      jobs: { total_count: jobs.length, jobs },
      source: snapshot(sourceSha),
      tested: snapshot(testedSha, false, [baseSha, sourceSha]),
      target: snapshot(targetSha, true, [sourceSha]),
      comparison: {
        status: "ahead",
        base_commit: { sha: sourceSha },
        merge_base_commit: { sha: sourceSha },
      },
    },
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: QUALIFICATION_REPOSITORY,
      GITHUB_SHA: targetSha,
      GH_TOKEN: "fixture-token",
    },
  };
}
