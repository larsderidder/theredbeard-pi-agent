---
name: gitlab
description: "Interact with GitLab using the `glab` CLI. Use `glab issue`, `glab mr`, `glab pipeline`, and `glab api` for issues, merge requests, CI pipelines, and advanced queries."
---

# GitLab Skill

Use the `glab` CLI to interact with GitLab. Always specify `--repo owner/repo` or `--group group` when not in a git directory, or use URLs directly.

## Important Restrictions

**NEVER push without explicit user approval.** Before running any command that pushes commits, tags, or branches, ask the user for confirmation.

**NEVER comment on issues, merge requests, or commits on behalf of the user.** Do not use `glab mr note`, `glab issue note`, or any other commenting functionality. Draft comments for the user to post themselves.

## Merge Requests

Check CI status on an MR:
```bash
glab mr ci-status 55 --repo owner/repo
```

View MR details:
```bash
glab mr view 55 --repo owner/repo
```

List recent MRs:
```bash
glab mr list --repo owner/repo --limit 10
```

## CI/CD Pipelines

List recent pipelines:
```bash
glab pipeline list --repo owner/repo --limit 10
```

View pipeline details:
```bash
glab pipeline view <pipeline-id> --repo owner/repo
```

View pipeline jobs:
```bash
glab ci view --repo owner/repo
```

View logs for a specific job:
```bash
glab pipeline logs <pipeline-id> --job-name <job-name> --repo owner/repo
```

## API for Advanced Queries

The `glab api` command is useful for accessing data not available through other subcommands.

Get MR with specific fields:
```bash
glab api projects/:id/merge_requests/:merge_request_iid --jq '.title, .state, .author.username'
```

## JSON Output

Most commands support `--output json` for structured output. You can use `--jq` to filter:

```bash
glab issue list --repo owner/repo --output json --jq '.[] | "\(.iid): \(.title)"'
```
