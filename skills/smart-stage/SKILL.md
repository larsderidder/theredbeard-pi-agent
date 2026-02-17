---
name: smart-stage
description: "Group unstaged changes into logical commits. Analyzes dirty working tree, clusters related files by purpose, and walks through each group as a separate commit. Use when you have many changed files and want clean, atomic commits."
---

# Smart Stage

Turn a messy working tree into a series of clean, logical commits.

## Step 1: Survey the changes

Run:

```bash
git status --short
git diff --stat
```

If there are also untracked files the user might want to include, list those separately and ask whether any should be included. Ignore common noise (`.DS_Store`, `__pycache__/`, `node_modules/`, etc.).

## Step 2: Understand each change

For tracked modified files, read the diffs:

```bash
git diff <file>
```

For untracked files the user wants to include, read them briefly to understand their purpose.

Build a mental model of what each change does. Keep notes short: one line per file.

## Step 3: Cluster into logical groups

Group the changes into commit-sized clusters. Each cluster should represent one coherent unit of work. Good groupings:

- A new feature and its tests
- A refactor that touches several files for the same reason
- Dependency or config updates
- Documentation changes
- Bug fixes (one per fix, unless they are closely related)
- Formatting or linting changes

Rules:
- Prefer fewer, well-scoped commits over many tiny ones. Do not split unless there is a real logical boundary.
- A single file can only belong to one group.
- If a file contains changes that logically belong to two groups, keep it in the group where it fits best. Do not try to partially stage hunks unless the user asks for it.

## Step 4: Present the plan

Show the user a numbered list of proposed commits. For each one, show:

1. A draft commit subject
2. The files included
3. A one-sentence explanation of why these belong together

Example:

```
1. feat(parser): add support for nested expressions
   Files: src/parser.ts, tests/parser.test.ts
   New parsing logic and its tests.

2. fix(api): handle null response from upstream
   Files: src/api/client.ts
   Guard against null when the upstream service returns an empty body.

3. chore: update dependencies
   Files: package.json, package-lock.json
   Routine dependency bump.
```

Ask the user to confirm, reorder, merge groups, split groups, or adjust commit messages before proceeding. Do not start committing until the user approves.

## Step 5: Execute commits

For each approved group, in order, follow the `commit` skill to stage and commit those files. All commit format rules, conventions, and constraints are defined there. Do not restate them here.

If any commit fails, stop and report the error. Do not continue to the next group.

## Step 6: Summary

After all commits are done, run `git log --oneline -n <number_of_commits>` to show the result.

## Notes

- If the working tree is clean, say so and stop.
- If there is only one logical group, just commit it directly without presenting a plan.
- If the user provides arguments, treat them as guidance for grouping or scoping (file paths to limit scope, instructions for how to split, etc.).
- When the user asks for partial hunk staging, use `git add -p` interactively or `git add --patch` with explicit hunk selection.
