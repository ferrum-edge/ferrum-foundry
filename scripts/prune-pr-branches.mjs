import { appendFileSync } from "node:fs";

const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isProtectedBranchName(branch, defaultBranch) {
  return !branch
    || branch === defaultBranch
    || PROTECTED_BRANCHES.has(branch)
    || branch.startsWith("release")
    || branch.startsWith("refs/");
}

function pullKey(repository, pull) {
  return pull?.head?.repo?.full_name === repository && typeof pull?.head?.ref === "string"
    ? pull.head.ref
    : undefined;
}

export function selectCandidates({
  repository,
  defaultBranch,
  closedPulls,
  openPulls,
  staleDays,
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(staleDays) || staleDays < 1 || staleDays > 3650) {
    throw new Error("staleDays must be an integer between 1 and 3650");
  }

  const openBranches = new Set(openPulls.map((pull) => pullKey(repository, pull)).filter(Boolean));
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const latestClosedByBranch = new Map();

  for (const pull of closedPulls) {
    const branch = pullKey(repository, pull);
    if (pull?.state !== "closed" || !branch || openBranches.has(branch)) continue;
    if (isProtectedBranchName(branch, defaultBranch)) continue;
    if (!Number.isSafeInteger(pull.number) || typeof pull.head.sha !== "string" || !pull.head.sha) continue;

    const eventAt = parseTimestamp(pull.closed_at) ?? parseTimestamp(pull.merged_at);
    if (eventAt === undefined) continue;
    const previous = latestClosedByBranch.get(branch);
    const previousEventAt = previous
      ? (parseTimestamp(previous.closed_at) ?? parseTimestamp(previous.merged_at) ?? 0)
      : 0;
    if (!previous || eventAt > previousEventAt || (eventAt === previousEventAt && pull.number > previous.number)) {
      latestClosedByBranch.set(branch, pull);
    }
  }

  const candidates = [];
  for (const [branch, pull] of latestClosedByBranch) {

    const mergedAt = parseTimestamp(pull.merged_at);
    const closedAt = parseTimestamp(pull.closed_at);
    let reason;
    if (mergedAt !== undefined) {
      reason = "merged";
    } else if (closedAt !== undefined && closedAt <= cutoff) {
      reason = "stale_closed_unmerged";
    } else {
      continue;
    }

    candidates.push({
      branch,
      headSha: pull.head.sha,
      pullNumber: pull.number,
      reason,
      closedAt: pull.closed_at,
    });
  }

  return candidates.sort((left, right) => left.branch.localeCompare(right.branch));
}

export function validateLiveState({ repository, defaultBranch, candidate, pull, branch, openPulls }) {
  if (pull?.number !== candidate.pullNumber || pull?.state !== "closed") return "pull_request_changed";
  if (pullKey(repository, pull) !== candidate.branch || pull.head.sha !== candidate.headSha) {
    return "pull_request_head_changed";
  }
  if (openPulls.some((openPull) => pullKey(repository, openPull) === candidate.branch)) {
    return "branch_has_open_pull_request";
  }
  if (isProtectedBranchName(candidate.branch, defaultBranch) || branch?.protected) {
    return "branch_is_protected";
  }
  if (!branch?.commit?.sha) return "branch_not_found";
  if (branch.commit.sha !== candidate.headSha) return "branch_sha_changed";
  return undefined;
}

function parseArguments(argv) {
  const values = { dryRun: false, deleteLive: false, staleDays: 30, confirmation: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") values.dryRun = true;
    else if (argument === "--delete") values.deleteLive = true;
    else if (argument === "--stale-days") values.staleDays = Number(argv[++index]);
    else if (argument === "--confirm-repository") values.confirmation = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (values.dryRun === values.deleteLive) {
    throw new Error("Specify exactly one of --dry-run or --delete");
  }
  return values;
}

function nextPage(linkHeader) {
  return linkHeader?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith('rel="next"'))
    ?.match(/^<([^>]+)>/)?.[1];
}

async function run() {
  const args = parseArguments(process.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const apiOrigin = new URL(apiUrl).origin;
  if (!repository?.match(/^[^/]+\/[^/]+$/)) throw new Error("GITHUB_REPOSITORY must be owner/repository");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (args.deleteLive && args.confirmation !== repository) {
    throw new Error(`Live deletion requires --confirm-repository ${repository}`);
  }

  const request = async (path, options = {}) => {
    const url = path.startsWith("http") ? path : `${apiUrl}${path}`;
    if (new URL(url).origin !== apiOrigin) throw new Error("Refusing to send credentials outside GITHUB_API_URL");
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ferrum-foundry-safe-branch-pruner",
        ...options.headers,
      },
    });
    if (options.allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} failed with ${response.status}`);
    }
    if (response.status === 204) return undefined;
    return { body: await response.json(), next: nextPage(response.headers.get("link")) };
  };

  const paginate = async (path) => {
    const items = [];
    let next = `${apiUrl}${path}`;
    let pageCount = 0;
    while (next) {
      pageCount += 1;
      if (pageCount > 1000) throw new Error("Pagination exceeded the 1000-page safety bound");
      const page = await request(next);
      if (!Array.isArray(page.body)) throw new Error("Expected a paginated array response");
      items.push(...page.body);
      next = page.next;
    }
    return items;
  };

  const repo = (await request(`/repos/${repository}`)).body;
  const [closedPulls, openPulls] = await Promise.all([
    paginate(`/repos/${repository}/pulls?state=closed&per_page=100`),
    paginate(`/repos/${repository}/pulls?state=open&per_page=100`),
  ]);
  const candidates = selectCandidates({
    repository,
    defaultBranch: repo.default_branch,
    closedPulls,
    openPulls,
    staleDays: args.staleDays,
  });

  const dryRunBranches = args.dryRun
    ? new Map((await paginate(`/repos/${repository}/branches?per_page=100`)).map((branch) => [branch.name, branch]))
    : undefined;
  const closedPullsByNumber = new Map(closedPulls.map((pull) => [pull.number, pull]));
  let planned = 0;
  let deleted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (args.dryRun) {
      const skipReason = validateLiveState({
        repository,
        defaultBranch: repo.default_branch,
        candidate,
        pull: closedPullsByNumber.get(candidate.pullNumber),
        branch: dryRunBranches.get(candidate.branch),
        openPulls,
      });
      if (skipReason) {
        skipped += 1;
        console.log(JSON.stringify({ action: "skipped", skip_reason: skipReason, ...candidate }));
        continue;
      }
      planned += 1;
      console.log(JSON.stringify({ action: "would_delete", ...candidate }));
      continue;
    }

    const owner = repository.split("/")[0];
    const [currentPullResult, currentHeadPulls, currentBranchResult] = await Promise.all([
      request(`/repos/${repository}/pulls/${candidate.pullNumber}`),
      paginate(`/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${candidate.branch}`)}&per_page=100`),
      request(`/repos/${repository}/branches/${encodeURIComponent(candidate.branch)}`, { allowNotFound: true }),
    ]);
    const pullsByNumber = new Map(currentHeadPulls.map((pull) => [pull.number, pull]));
    pullsByNumber.set(currentPullResult.body.number, currentPullResult.body);
    const currentPulls = [...pullsByNumber.values()];
    const currentOpenPulls = currentPulls.filter((pull) => pull.state === "open");
    const refreshedCandidate = selectCandidates({
      repository,
      defaultBranch: repo.default_branch,
      closedPulls: currentPulls.filter((pull) => pull.state === "closed"),
      openPulls: currentOpenPulls,
      staleDays: args.staleDays,
    })[0];
    const skipReason = !refreshedCandidate
      || refreshedCandidate.branch !== candidate.branch
      || refreshedCandidate.headSha !== candidate.headSha
      || refreshedCandidate.reason !== candidate.reason
      ? "pull_request_no_longer_eligible"
      : validateLiveState({
          repository,
          defaultBranch: repo.default_branch,
          candidate,
          pull: currentPullResult.body,
          branch: currentBranchResult?.body,
          openPulls: currentOpenPulls,
        });
    if (skipReason) {
      skipped += 1;
      console.log(JSON.stringify({ action: "skipped", skip_reason: skipReason, ...candidate }));
      continue;
    }

    planned += 1;
    await request(`/repos/${repository}/git/refs/heads/${encodeURIComponent(candidate.branch)}`, {
      method: "DELETE",
    });
    deleted += 1;
    console.log(JSON.stringify({ action: "deleted", ...candidate }));
  }

  const summary = {
    mode: args.dryRun ? "dry_run" : "live_delete",
    eligible_pull_requests: candidates.length,
    planned,
    deleted,
    skipped,
  };
  console.log(JSON.stringify({ action: "summary", ...summary }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Branch pruning\n\n\`${JSON.stringify(summary)}\`\n`,
    );
  }
}

if (process.argv[1]?.endsWith("prune-pr-branches.mjs")) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : "Branch pruning failed");
    process.exitCode = 1;
  });
}
