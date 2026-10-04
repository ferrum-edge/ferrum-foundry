import { isDeepStrictEqual } from "node:util";

export const QUALIFICATION_REPOSITORY = "ferrum-edge/ferrum-foundry";
export const QUALIFICATION_WORKFLOW = ".github/workflows/ci.yml";
export const QUALIFICATION_RECORD = "docs/compatibility.json";
export const QUALIFICATION_JOBS = [
  "Quality Gate (Node 22)",
  "Quality Gate (Node 24)",
  "Pinned Gateway Contract",
  "Deployment Starter",
  "Critical Journeys",
  "Container Gate (linux/amd64)",
  "Container Gate (linux/arm64)",
];

const COMMIT = /^[0-9a-f]{40}$/;
const RUN_URL = /^https:\/\/github\.com\/ferrum-edge\/ferrum-foundry\/actions\/runs\/([1-9]\d*)$/;
const IDENTITY_FIELDS = ["ci_evidence", "source_commit", "tested_commit", "run_attempt"];

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function qualificationErrors(qualification) {
  const errors = [];
  if (!["pending", "qualified"].includes(qualification?.status)) {
    return ['qualification.status must be "pending" or "qualified"'];
  }
  if (Object.keys(qualification).some((field) => !["status", ...IDENTITY_FIELDS].includes(field))) {
    errors.push("qualification may contain only status and the four hosted evidence fields");
  }
  if (qualification.status === "pending") {
    for (const field of IDENTITY_FIELDS) {
      if (qualification[field] !== null) errors.push(`pending qualification.${field} must be null`);
    }
    return errors;
  }
  const runId = Number(RUN_URL.exec(qualification.ci_evidence ?? "")?.[1]);
  if (!positiveInteger(runId)) {
    errors.push("qualification.ci_evidence must name the hosted qualification run");
  }
  for (const field of ["source_commit", "tested_commit"]) {
    if (!COMMIT.test(qualification[field] ?? "")) {
      errors.push(`qualification.${field} must be a full commit SHA`);
    }
  }
  if (!positiveInteger(qualification.run_attempt)) {
    errors.push("qualification.run_attempt must be a positive safe integer");
  }
  return errors;
}

function requireRecordedQualification(record) {
  if (
    record?.qualification?.status !== "qualified" ||
    qualificationErrors(record.qualification).length
  ) {
    throw new Error(
      "The pairing's hosted qualification is still pending; record a successful run and sources first.",
    );
  }
}

function withoutQualification(record) {
  const copy = structuredClone(record);
  delete copy.qualification;
  return copy;
}

/** Compare every tracked path/mode/blob, including workflows, pins and tests. */
function treeIdentity(snapshot) {
  const { commit, tree } = snapshot ?? {};
  if (
    !COMMIT.test(commit?.sha ?? "") || !COMMIT.test(commit?.tree?.sha ?? "") ||
    tree?.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)
  ) {
    throw new Error("Hosted qualification has missing or truncated source trees");
  }
  const paths = new Set();
  const entries = tree.tree.map((entry) => {
    if (
      typeof entry.path !== "string" || paths.has(entry.path) ||
      !COMMIT.test(entry.sha ?? "") || !["tree", "blob", "commit"].includes(entry.type) ||
      !["040000", "100644", "100755", "120000", "160000"].includes(entry.mode)
    ) {
      throw new Error("Hosted qualification has invalid source tree entries");
    }
    paths.add(entry.path);
    // Directory hashes necessarily change when the evidence record changes.
    return [entry.path, entry.mode, entry.type, entry.type === "tree" ? null : entry.sha];
  });
  const recordEntry = tree.tree.find((entry) => entry.path === QUALIFICATION_RECORD);
  if (recordEntry?.type !== "blob" || recordEntry.mode !== "100644") {
    throw new Error("Hosted qualification is missing its ordinary compatibility record");
  }
  return entries
    .filter(([path]) => path !== QUALIFICATION_RECORD)
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Pure, fail-closed validation seam. All evidence comes from the reader below. */
export function requireHostedQualification(record, evidence) {
  requireRecordedQualification(record);
  const qualification = record.qualification;
  const { run, workflow, jobs, source, tested, target, comparison } = evidence ?? {};
  const runId = Number(RUN_URL.exec(qualification.ci_evidence)[1]);
  if (
    run?.id !== runId || run.repository?.full_name !== QUALIFICATION_REPOSITORY ||
    run.head_repository?.full_name !== QUALIFICATION_REPOSITORY ||
    !positiveInteger(run.repository.id) || run.head_repository.id !== run.repository.id ||
    run.path !== QUALIFICATION_WORKFLOW || workflow?.path !== QUALIFICATION_WORKFLOW ||
    !positiveInteger(workflow.id) || run.workflow_id !== workflow.id ||
    run.head_sha !== qualification.source_commit || run.run_attempt !== qualification.run_attempt ||
    !["pull_request", "push"].includes(run.event)
  ) {
    throw new Error(
      "Hosted qualification run does not match the repository, workflow, attempt or source",
    );
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Hosted qualification run must be completed and successful");
  }
  if (
    !Array.isArray(jobs?.jobs) || !positiveInteger(jobs.total_count) ||
    jobs.total_count !== jobs.jobs.length || jobs.jobs.length > 1000
  ) {
    throw new Error("Hosted qualification jobs are missing or incomplete");
  }
  const required = [
    ...QUALIFICATION_JOBS,
    `Qualification Source (${qualification.tested_commit})`,
  ];
  const jobIds = new Set();
  for (const name of required) {
    const matches = jobs.jobs.filter((job) => job.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 || !positiveInteger(job.id) || jobIds.has(job.id) ||
      job.run_id !== runId || job.run_attempt !== qualification.run_attempt ||
      job.head_sha !== qualification.source_commit ||
      job.status !== "completed" || job.conclusion !== "success"
    ) {
      throw new Error(`Hosted qualification requires one successful current-attempt job: ${name}`);
    }
    jobIds.add(job.id);
  }

  const sourceIdentity = treeIdentity(source);
  const testedIdentity = treeIdentity(tested);
  const targetIdentity = treeIdentity(target);
  if (
    source.commit.sha !== qualification.source_commit ||
    tested.commit.sha !== qualification.tested_commit
  ) {
    throw new Error("Hosted qualification commit identities do not match the record");
  }
  if (run.event === "pull_request") {
    const pullRequests = Array.isArray(run.pull_requests)
      ? run.pull_requests.filter((pr) => pr.head?.sha === qualification.source_commit)
      : [];
    const pr = pullRequests?.[0];
    if (
      pullRequests?.length !== 1 || pr.head.repo?.id !== run.repository.id ||
      pr.base?.repo?.id !== run.repository.id || pr.base.ref !== "main" ||
      !COMMIT.test(pr.base.sha ?? "") || tested.commit.parents?.length !== 2 ||
      tested.commit.parents[0].sha !== pr.base.sha ||
      tested.commit.parents[1].sha !== qualification.source_commit
    ) {
      throw new Error(
        "Hosted qualification does not bind the tested PR merge to its actual head and base",
      );
    }
  } else if (run.head_branch !== "main" || tested.commit.sha !== source.commit.sha) {
    throw new Error("Hosted push qualification must test the main source commit");
  }
  if (
    target.commit.sha !== source.commit.sha && (
      !["ahead", "identical"].includes(comparison?.status) ||
      comparison.base_commit?.sha !== source.commit.sha ||
      comparison.merge_base_commit?.sha !== source.commit.sha
    )
  ) {
    throw new Error("Hosted qualification source is not an ancestor of the release target");
  }
  if (
    !isDeepStrictEqual(sourceIdentity, testedIdentity) ||
    !isDeepStrictEqual(sourceIdentity, targetIdentity)
  ) {
    throw new Error(
      "Code, pins, workflows or other tracked files changed after hosted qualification",
    );
  }
  if (
    source.record?.qualification?.status !== "pending" ||
    qualificationErrors(source.record.qualification).length ||
    !isDeepStrictEqual(source.record.qualification, tested.record?.qualification) ||
    !isDeepStrictEqual(withoutQualification(record), withoutQualification(source.record)) ||
    !isDeepStrictEqual(withoutQualification(record), withoutQualification(tested.record)) ||
    !isDeepStrictEqual(record, target.record)
  ) {
    throw new Error(
      "Only qualification evidence may change in the record after the pending tree passes CI",
    );
  }
}

/** No arbitrary URLs, redirects, response bodies, credentials or causes in failures. */
export function githubQualificationReader(token, fetchImpl = fetch) {
  return async (path) => {
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${QUALIFICATION_REPOSITORY}/${path}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("GitHub request failed");
      return await response.json();
    } catch {
      throw new Error("Could not read hosted qualification evidence from GitHub; release refused");
    }
  };
}

async function readSnapshot(sha, read) {
  const commit = await read(`git/commits/${sha}`);
  if (commit?.sha !== sha || !COMMIT.test(commit.tree?.sha ?? "")) {
    throw new Error("GitHub returned an invalid qualification commit");
  }
  const tree = await read(`git/trees/${commit.tree.sha}?recursive=1`);
  const snapshot = { commit, tree };
  treeIdentity(snapshot);
  const entry = tree.tree.find((item) => item.path === QUALIFICATION_RECORD);
  const blob = await read(`git/blobs/${entry.sha}`);
  if (
    blob?.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string" ||
    !positiveInteger(blob.size) || blob.size > 1024 * 1024
  ) {
    throw new Error("GitHub returned an invalid qualification record blob");
  }
  try {
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length !== blob.size) throw new Error("Incomplete blob");
    snapshot.record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub returned an unreadable qualification record");
  }
  return snapshot;
}

/** Hosted release only; bounded API reads with actions:read and contents:read. */
export async function readHostedQualification(record, env = process.env, read) {
  requireRecordedQualification(record);
  if (
    env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== QUALIFICATION_REPOSITORY ||
    !COMMIT.test(env.GITHUB_SHA ?? "") || !env.GH_TOKEN
  ) {
    throw new Error(
      "Release readiness requires hosted GitHub Actions with read-only qualification access",
    );
  }
  read ??= githubQualificationReader(env.GH_TOKEN);
  const qualification = record.qualification;
  const runId = Number(RUN_URL.exec(qualification.ci_evidence)[1]);
  const run = await read(`actions/runs/${runId}`);
  const workflow = await read("actions/workflows/ci.yml");
  // Use this exact attempt, never successful jobs inherited from older attempts.
  const jobs = { total_count: 0, jobs: [] };
  for (let page = 1; page <= 10; page += 1) {
    const result = await read(
      `actions/runs/${runId}/attempts/${qualification.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    if (
      !positiveInteger(result?.total_count) || result.total_count > 1000 ||
      !Array.isArray(result.jobs) || result.jobs.length > 100 ||
      (page > 1 && result.total_count !== jobs.total_count)
    ) {
      throw new Error("GitHub returned incomplete qualification jobs");
    }
    jobs.total_count = result.total_count;
    jobs.jobs.push(...result.jobs);
    if (jobs.jobs.length >= jobs.total_count) break;
    if (result.jobs.length !== 100) throw new Error("GitHub returned incomplete qualification jobs");
  }
  const [source, tested, target, comparison] = await Promise.all([
    readSnapshot(qualification.source_commit, read),
    readSnapshot(qualification.tested_commit, read),
    readSnapshot(env.GITHUB_SHA, read),
    qualification.source_commit === env.GITHUB_SHA
      ? null
      : read(`compare/${qualification.source_commit}...${env.GITHUB_SHA}`),
  ]);
  const evidence = { run, workflow, jobs, source, tested, target, comparison };
  requireHostedQualification(record, evidence);
  // Refuse a run re-started while its evidence was being read.
  const latest = await read(`actions/runs/${runId}`);
  if (!isDeepStrictEqual(run, latest)) {
    throw new Error("Hosted qualification run changed during verification; release refused");
  }
  return evidence;
}
