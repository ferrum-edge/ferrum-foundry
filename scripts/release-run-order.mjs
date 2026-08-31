import { pathToFileURL } from 'node:url';

export function blockingReleaseRuns(payload, currentRunNumber, currentRunId, workflowPath) {
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub Actions response does not contain workflow_runs');
  }
  if (!Number.isSafeInteger(currentRunNumber) || currentRunNumber <= 0) {
    throw new Error('GITHUB_RUN_NUMBER must be a positive safe integer');
  }
  if (!Number.isSafeInteger(currentRunId) || currentRunId <= 0) {
    throw new Error('GITHUB_RUN_ID must be a positive safe integer');
  }
  if (!workflowPath) throw new Error('RELEASE_WORKFLOW_PATH is required');

  return payload.workflow_runs
    .filter((run) => (
      run
      && run.path === workflowPath
      && run.id !== currentRunId
      && Number.isSafeInteger(run.run_number)
      && run.run_number < currentRunNumber
      && run.status !== 'completed'
    ))
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
