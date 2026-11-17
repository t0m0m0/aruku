# Git Workflow

## Commit Format

`feat(#ISSUE_NUMBER): short summary`

## Branch Rules

- Create one branch per issue
- Never commit directly to main

## Pull Requests

- Open PRs as ready for review, not as drafts (Codex reviews only non-draft PRs)
- Summarize:
  - What changed
  - Why
  - Test coverage

## Merging

- Merge the PR yourself once all of these hold — no need to ask for confirmation:
  - Codex review has completed on the current head commit (the `codex-review-state` summary comment
    shows `"status":"completed"` for that `commit_sha`)
  - Codex findings are all addressed (fixed and pushed, which triggers a new review, or answered with a reason)
  - CI is green and the PR has no merge conflict
- Merge with a merge commit: `gh api -X PUT repos/t0m0m0/aruku/pulls/<number>/merge -f merge_method=merge`

## Code Review

- After addressing `/review` feedback, commit and push immediately without asking for confirmation
