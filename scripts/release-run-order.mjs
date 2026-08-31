import { pathToFileURL } from 'node:url';

export function blockingReleaseRuns(payload, currentRunNumber, currentRunId, workflowPath) {
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub Actions response does not contain workflow_runs');
  }
  if (!Number.isSafeInteger(payload.total_count) || payload.total_count !== payload.workflow_runs.length) {
    throw new Error('GitHub Actions response is incomplete');
  }
  if (!Number.isSafeInteger(currentRunNumber) || currentRunNumber <= 0) {
    throw new Error('GITHUB_RUN_NUMBER must be a positive safe integer');
  }
  if (!Number.isSafeInteger(currentRunId) || currentRunId <= 0) {
    throw new Error('GITHUB_RUN_ID must be a positive safe integer');
  }
  if (!workflowPath) throw new Error('RELEASE_WORKFLOW_PATH is required');

  const relevantRuns = payload.workflow_runs.filter((run) => run?.path === workflowPath);
  if (relevantRuns.some((run) => (
    !Number.isSafeInteger(run.id)
    || !Number.isSafeInteger(run.run_number)
    || typeof run.status !== 'string'
  ))) {
    throw new Error('GitHub Actions response contains an invalid release run');
  }

  const blockersById = new Map(relevantRuns
    .filter((run) => (
      run.id !== currentRunId
      && run.run_number < currentRunNumber
      && run.status !== 'completed'
    ))
    .map((run) => [run.id, run]));

  return [...blockersById.values()]
    .sort((left, right) => left.run_number - right.run_number)
    .map((run) => ({ id: run.id, runNumber: run.run_number, status: run.status }));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const blockers = blockingReleaseRuns(
    payload,
    Number(process.env.GITHUB_RUN_NUMBER),
    Number(process.env.GITHUB_RUN_ID),
    process.env.RELEASE_WORKFLOW_PATH,
  );
  process.stdout.write(blockers.map((run) => `${run.runNumber}:${run.id}:${run.status}`).join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Release run ordering failed');
    process.exitCode = 1;
  });
}
