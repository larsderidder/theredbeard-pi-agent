---
name: code-quality
description: "Focused code quality audit: find duplication, dead code, god components, missing types, incomplete docstrings, and model/data inconsistencies. Scope to unstaged changes, unpushed commits, specific paths, or the full codebase. Report findings or apply fixes directly."
---

# Code Quality Audit

Parse the user's request for three things. Ask if unclear.

## Scope

What code to audit. Exactly one of:

| Scope | Files |
|-------|-------|
| **unstaged** | `git diff --name-only` |
| **unpushed** | `git log --name-only --pretty=format: @{u}..HEAD \| sort -u` (fall back to `origin/main..HEAD`) |
| **path** | User-provided files, directories, or globs |
| **all** | `git ls-files` |

Filter to source files only. Skip images, lockfiles, build output, `node_modules`. If zero files, stop. If >200 files, confirm or suggest narrowing.

## Mode

| Mode | Behavior |
|------|----------|
| **report** | Structured Markdown report. Do NOT edit files. |
| **fix** | Apply fixes directly. Summarize what changed and why. Flag anything too risky as "Manual review needed." |

If not specified, ask.

## Checks

After determining scope and mode, present the list of checks and let the user pick which ones to run. If the user already specified checks in their request, use those without asking.

### 1. Duplication
Identical or near-identical function bodies, repeated inline logic (5+ lines), overlapping type/interface definitions, constants or enums defined in multiple places, same-purpose utilities under different names. Cross-reference the full project, not just scoped files. In fix mode: extract to a single location, update call sites.

### 2. Dead Code
Exported symbols with zero imports elsewhere, internal symbols never referenced in their own file, files nothing imports from, commented-out code blocks (git has history), unreachable code. Before flagging, rule out false positives: dynamic imports/require, framework hooks and lifecycle methods, test-only exports (public API surface), reflection or string-based references, `window`/global scope access. In fix mode: delete dead code and stale imports.

### 3. Component Structure
Files over 300 lines warrant inspection. Components managing multiple unrelated state concerns, classes with 8+ methods spanning different responsibilities, files mixing data fetching, business logic, and presentation, functions with 5+ parameters. In report mode: propose concrete splits (new file names, what moves where, interface between them). In fix mode: perform the extraction unless the split is complex enough to risk breakage; flag those instead.

### 4. Comments and Docstrings
Public functions/classes/types missing docstrings, stale docstrings that no longer match behavior, comments that restate the code, naked TODO/FIXME without context, inconsistent docstring style within the project. Match the project's existing conventions, not an arbitrary standard. In fix mode: add missing docstrings, fix stale ones, remove useless comments.

### 5. Typing Consistency
Explicit `any`, implicit `any` from missing annotations, `as` assertions (especially `as any` or double casts), unexplained `@ts-ignore`/`@ts-expect-error`, generic types that are too loose (`Record<string, any>`), exported functions missing return types, inconsistent use of interfaces vs type aliases. In fix mode: replace `any` with proper types, add annotations, remove unjustified assertions.

### 6. Model / Data Format Consistency
API response types that don't match fetch code (extra/missing fields, wrong optionality), validation schemas (Zod/Yup/Joi) that diverge from their TypeScript counterparts, form data shapes that differ from the API payload, enums or unions that don't cover all actual values, serialization boundaries where fields are renamed or dropped without types reflecting it. Trace the data flow at each boundary. If it's unclear which side is "correct," flag it rather than guessing.

## Output

### Report Mode

```
# Code Quality Report
**Scope**: [what was audited]
**Files**: [count]

## Summary
[2-3 sentences on biggest issues]

## Findings
### Critical / High / Medium / Low
[file:line, description, suggested fix]

## Stats
| Check | Findings |
|-------|----------|
| ... | ... |
```

### Fix Mode

Print a grouped summary of changes. List ambiguous or risky items under "Manual review needed."

## Principles

- Every finding references a specific file and line.
- Use absolute counts, not percentages. "3 duplicated functions across 4 files," not "50% duplication." Concrete numbers enable decisions; percentages obscure them.
- Respect the codebase's existing style and conventions.
- Only report on files in scope. Cross-reference the full project when checking usage.
- If a check doesn't apply (e.g., no API calls for check 6), say so and skip it.
