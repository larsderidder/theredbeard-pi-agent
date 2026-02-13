---
name: resolve-conflicts
description: "Resolve git merge, cherry-pick, and stash pop conflicts. Auto-resolves high-confidence conflicts and walks through ambiguous ones interactively with the user."
---

# Resolve Conflicts

Resolve git conflicts from merge, cherry-pick, rebase, or stash pop operations.

## Step 1: Assess the situation

Run `git status` to identify all conflicted files and the type of operation in progress (merge, cherry-pick, rebase, stash pop). List them for the user with a short summary of what is happening.

## Step 2: Understand the context

For each conflicted file, run:

```bash
git log --oneline -5 -- <file>
```

This gives context on recent changes to the file. If the operation is a merge, also check what branch is being merged and what its intent was.

## Step 3: Categorize each conflict

Read each conflicted file and classify every conflict hunk into one of two categories:

### Auto-resolvable (high confidence)

- Both sides added different imports or include statements
- One side made a change, the other side only has cosmetic or whitespace differences in the same region
- Both sides made identical changes (duplicate conflict markers from different merge bases)
- One side deleted code while the other made no meaningful changes to it
- Both sides added items to a list, array, or config block (ordering is not semantically important)
- Trivial adjacency conflicts where changes do not interact at all

### Needs review (ambiguous)

- Both sides changed the same function body or logic in different ways
- Conflicting changes to the same variable, return value, or condition
- One side refactored or renamed something the other side also modified
- Structural changes (moved code, changed signatures) overlapping with content changes
- Anything where the correct resolution depends on understanding intent you are not sure about

## Step 4: Resolve and present

### Auto-resolved conflicts

For each high-confidence conflict, resolve it directly using `edit`. After resolving all of them in a file, present a brief summary:

```
Resolved <file> (<n> conflicts):
  - Lines 10-15: kept both import blocks
  - Lines 42-50: took theirs (whitespace-only difference on our side)
```

### Ambiguous conflicts

Use the `resolve_conflict` tool for each ambiguous conflict. It presents an interactive UI where the user can pick ours, theirs, your suggestion, or type a custom resolution.

When calling `resolve_conflict`:
- `file`: the conflicted file path
- `location`: the line range or function name (e.g., "lines 42-58" or "handleAuth()")
- `context`: a brief explanation of what each side was trying to do
- `ours`: the exact code from our side (current branch), without conflict markers
- `theirs`: the exact code from their side (incoming), without conflict markers
- `suggestion`: your suggested resolution, if you have a reasonable one. Omit this field entirely if you are truly unsure.

After the user makes a choice, apply the returned resolution to the file with `edit`.

## Step 5: Verify and finalize

After all conflicts are resolved:

1. Run `git diff` to show the final state of previously conflicted files
2. If the project has a build or test command visible in the repo (package.json scripts, Makefile, etc.), suggest running it
3. Stage the resolved files with `git add <file>` for each resolved file
4. Tell the user the resolved files have been staged and remind them to run `git merge --continue`, `git cherry-pick --continue`, `git rebase --continue`, or `git stash drop` depending on the operation type. Do not run these commands yourself.

## Principles

- Never silently discard changes from either side.
- When in doubt, ask. A wrong auto-resolution is worse than a question.
- Preserve the intent of both sides, not just the text.
- If a file has a mix of easy and hard conflicts, resolve the easy ones and present the hard ones. Do not wait until all are categorized to start resolving.
- If there are many conflicted files, process them one file at a time so the user can follow along.
