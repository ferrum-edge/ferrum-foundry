import assert from 'node:assert/strict';
import test from 'node:test';
import { blockingReleaseRuns } from './release-run-order.mjs';

const WORKFLOW_PATH = '.github/workflows/release.yml';

test('release promotion waits for every earlier active run in run-number order', () => {
  const blockers = blockingReleaseRuns({
    total_count: 5,
    workflow_runs: [
      { id: 50, run_number: 5, status: 'in_progress', path: WORKFLOW_PATH },
      { id: 30, run_number: 3, status: 'queued', path: WORKFLOW_PATH },
      { id: 40, run_number: 4, status: 'completed', path: WORKFLOW_PATH },
      { id: 60, run_number: 6, status: 'in_progress', path: WORKFLOW_PATH },
      { id: 20, run_number: 2, status: 'in_progress', path: '.github/workflows/ci.yml' },
    ],
  }, 6, 60, WORKFLOW_PATH);

  assert.deepEqual(blockers, [
    { id: 30, runNumber: 3, status: 'queued' },
    { id: 50, runNumber: 5, status: 'in_progress' },
  ]);
});

test('completed, current, newer, and unrelated runs never block promotion', () => {
  const blockers = blockingReleaseRuns({
    total_count: 4,
    workflow_runs: [
      { id: 10, run_number: 1, status: 'completed', path: WORKFLOW_PATH },
      { id: 20, run_number: 2, status: 'in_progress', path: WORKFLOW_PATH },
      { id: 30, run_number: 3, status: 'queued', path: WORKFLOW_PATH },
      { id: 5, run_number: 1, status: 'in_progress', path: '.github/workflows/ci.yml' },
    ],
  }, 2, 20, WORKFLOW_PATH);
  assert.deepEqual(blockers, []);
});

test('malformed API responses and run identities fail closed', () => {
  assert.throws(() => blockingReleaseRuns({}, 2, 20, WORKFLOW_PATH), /workflow_runs/);
  assert.throws(
    () => blockingReleaseRuns({ total_count: 0, workflow_runs: [] }, Number.NaN, 20, WORKFLOW_PATH),
    /GITHUB_RUN_NUMBER/,
  );
  assert.throws(
    () => blockingReleaseRuns({ total_count: 0, workflow_runs: [] }, 2, 0, WORKFLOW_PATH),
    /GITHUB_RUN_ID/,
  );
  assert.throws(
    () => blockingReleaseRuns({ total_count: 2, workflow_runs: [] }, 2, 20, WORKFLOW_PATH),
    /incomplete/,
  );
  assert.throws(
    () => blockingReleaseRuns({
      total_count: 1,
      workflow_runs: [{ id: 10, run_number: '1', status: 'queued', path: WORKFLOW_PATH }],
    }, 2, 20, WORKFLOW_PATH),
    /invalid release run/,
  );
});
