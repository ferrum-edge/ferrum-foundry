# Safe pull-request branch pruning

The `Prune Stale PR Branches` workflow never deletes during a scheduled run.
Schedules and ordinary manual runs only print a dry-run plan. Live deletion is
available solely through `workflow_dispatch` with `delete_live` enabled, the
exact repository name entered as confirmation, and approval from the protected
`branch-pruning` GitHub environment.

Repository administrators must configure required reviewers on that environment
before enabling live cleanup. Without the typed repository confirmation the live
job fails closed even after environment approval.

Immediately before each deletion, the workflow re-fetches GitHub state and
requires all of the following:

- the pull request is still closed;
- the head repository is this repository, not a fork;
- no open pull request uses the branch;
- the branch is not the default, `main`, `master`, `develop`, or any
  `release*` branch;
- GitHub does not mark the branch as protected; and
- the current branch ref still equals the exact pull-request head SHA.

If a branch name was reused by multiple closed pull requests, the newest closed
request controls eligibility. An older merged request can never bypass the
retention period of a newer closed-unmerged request with the same branch name.

Merged pull-request branches are candidates immediately. Closed, unmerged pull
requests become candidates only after `days_stale` (30 days by default). GitHub
API pagination is followed for both open and closed pull requests. A failed API
read or delete fails the workflow; it is never reported as a successful cleanup.
