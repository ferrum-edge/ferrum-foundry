# Safe pull-request branch pruning

The `Prune Stale PR Branches` workflow (`.github/workflows/prune-stale-prs.yml`,
running `scripts/prune-pr-branches.mjs`) deletes head branches of closed pull
requests. It runs weekly and can be started manually.

Scheduled runs and ordinary manual runs only print a dry-run plan. Live deletion
needs all three of:

- a `workflow_dispatch` run with `delete_live` enabled;
- `confirm_repository` set to the exact repository name
  (`ferrum-edge/ferrum-foundry`); without it the live job fails; and
- approval on the protected `branch-pruning` GitHub environment.

Repository administrators must configure required reviewers on that environment
before enabling live cleanup.

## Which branches are candidates

- Merged pull-request branches are candidates immediately.
- Closed, unmerged pull requests become candidates after `days_stale` days
  (default 30, allowed range 1–3650).
- If several closed pull requests used the same branch name, the most recently
  closed one decides. An older merged request cannot bypass the waiting period
  of a newer closed, unmerged one.

## Checks before each deletion

Just before deleting, the live job re-reads GitHub state and skips the branch
unless all of these still hold:

- the pull request is still closed and still eligible;
- its head repository is this repository, not a fork;
- no open pull request uses the branch;
- the branch is not the default branch, `main`, `master`, `develop`, or any
  branch starting with `release`;
- GitHub does not mark the branch as protected; and
- the branch still points at the exact pull-request head SHA.

All pages of open and closed pull requests are read. A failed API read or
delete fails the workflow; it is never reported as a successful cleanup.
