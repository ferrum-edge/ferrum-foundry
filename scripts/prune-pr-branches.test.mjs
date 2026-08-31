import assert from "node:assert/strict";
import test from "node:test";
import {
  isProtectedBranchName,
  selectCandidates,
  validateLiveState,
} from "./prune-pr-branches.mjs";

const repository = "ferrum-edge/ferrum-foundry";
const now = Date.parse("2026-08-30T00:00:00Z");

function pull(overrides = {}) {
  return {
    number: 1,
    state: "closed",
    merged_at: "2026-08-29T00:00:00Z",
    closed_at: "2026-08-29T00:00:00Z",
    head: {
      ref: "feature/safe",
      sha: "a".repeat(40),
      repo: { full_name: repository },
    },
    ...overrides,
  };
}

test("branch-name guard covers defaults, releases, and non-head ref spellings", () => {
  assert.equal(isProtectedBranchName("trunk", "trunk"), true);
  assert.equal(isProtectedBranchName("main", "trunk"), true);
  assert.equal(isProtectedBranchName("release/1.2", "trunk"), true);
  assert.equal(isProtectedBranchName("release-1.2", "trunk"), true);
  assert.equal(isProtectedBranchName("releases/1.2", "trunk"), true);
  assert.equal(isProtectedBranchName("refs/tags/v1", "trunk"), true);
  assert.equal(isProtectedBranchName("feature/safe", "trunk"), false);
});

test("the newest closed PR controls retention when a branch name was reused", () => {
  const candidates = selectCandidates({
    repository,
    defaultBranch: "main",
    staleDays: 30,
    now,
    closedPulls: [
      pull({
        number: 7,
        merged_at: "2026-06-01T00:00:00Z",
        closed_at: "2026-06-01T00:00:00Z",
        head: { ref: "feature/reused-closed", sha: "7".repeat(40), repo: { full_name: repository } },
      }),
      pull({
        number: 8,
        merged_at: null,
        closed_at: "2026-08-20T00:00:00Z",
        head: { ref: "feature/reused-closed", sha: "8".repeat(40), repo: { full_name: repository } },
      }),
    ],
    openPulls: [],
  });

  assert.deepEqual(candidates, []);
});

test("selection includes merged and aged closed PRs but rejects unsafe ownership and live reuse", () => {
  const candidates = selectCandidates({
    repository,
    defaultBranch: "main",
    staleDays: 30,
    now,
    closedPulls: [
      pull(),
      pull({
        number: 2,
        merged_at: null,
        closed_at: "2026-06-01T00:00:00Z",
        head: { ref: "feature/stale", sha: "b".repeat(40), repo: { full_name: repository } },
      }),
      pull({
        number: 3,
        head: { ref: "feature/fork", sha: "c".repeat(40), repo: { full_name: "outside/fork" } },
      }),
      pull({
        number: 4,
        merged_at: null,
        closed_at: "2026-08-20T00:00:00Z",
        head: { ref: "feature/too-new", sha: "d".repeat(40), repo: { full_name: repository } },
      }),
      pull({
        number: 5,
        head: { ref: "feature/reused", sha: "e".repeat(40), repo: { full_name: repository } },
      }),
    ],
    openPulls: [pull({
      number: 6,
      state: "open",
      merged_at: null,
      closed_at: null,
      head: { ref: "feature/reused", sha: "e".repeat(40), repo: { full_name: repository } },
    })],
  });

  assert.deepEqual(candidates.map(({ branch, reason }) => ({ branch, reason })), [
    { branch: "feature/safe", reason: "merged" },
    { branch: "feature/stale", reason: "stale_closed_unmerged" },
  ]);
});

test("live validation binds deletion to the re-fetched PR and exact branch SHA", () => {
  const currentPull = pull();
  const candidate = selectCandidates({
    repository,
    defaultBranch: "main",
    staleDays: 30,
    now,
    closedPulls: [currentPull],
    openPulls: [],
  })[0];

  assert.equal(validateLiveState({
    repository,
    defaultBranch: "main",
    candidate,
    pull: currentPull,
    branch: { protected: false, commit: { sha: candidate.headSha } },
    openPulls: [],
  }), undefined);
  assert.equal(validateLiveState({
    repository,
    defaultBranch: "main",
    candidate,
    pull: currentPull,
    branch: { protected: false, commit: { sha: "f".repeat(40) } },
    openPulls: [],
  }), "branch_sha_changed");
  assert.equal(validateLiveState({
    repository,
    defaultBranch: "main",
    candidate,
    pull: currentPull,
    branch: { protected: true, commit: { sha: candidate.headSha } },
    openPulls: [],
  }), "branch_is_protected");
  assert.equal(validateLiveState({
    repository,
    defaultBranch: "main",
    candidate,
    pull: currentPull,
    branch: undefined,
    openPulls: [],
  }), "branch_not_found");
});
