---
name: code-quality
description: "Focused code quality audit: find duplication, dead code, god components, missing types, incomplete docstrings, and model/data inconsistencies. Scope to unstaged changes, unpushed commits, specific paths, or the full codebase. Report findings or apply fixes directly."
---

# Code Quality Audit

Infer scope, mode, and emphasis from the request and available context. Ask only when a missing decision would materially change the work.

## Scope

Use the requested files or changes. Common ways to identify them:

| Scope | Files |
|-------|-------|
| **unstaged** | `git diff --name-only` |
| **unpushed** | `git log --name-only --pretty=format: @{u}..HEAD \| sort -u` (fall back to `origin/main..HEAD`) |
| **path** | User-provided files, directories, or globs |
| **all** | `git ls-files` |

Focus on relevant source files, excluding dependencies and generated output. If the requested scope cannot be covered meaningfully, explain the coverage limit and resolve it with the user rather than silently sampling.

## Mode

| Mode | Behavior |
|------|----------|
| **report** | Return findings without editing files. |
| **fix** | Apply fixes directly. Summarize what changed and why. Flag anything too risky as "Manual review needed." |

A review or audit defaults to report mode. Apply fixes when the user asks for changes; clarify genuinely ambiguous requests.

## Checks

Run the applicable checks below, guided by the user's stated concerns. Skip irrelevant checks without requiring a menu selection.

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

Return concise, evidence-backed findings with file locations, the concrete problem, and a possible correction. Explain severity where it helps distinguish consequential issues from optional improvements. Say when no substantive issues were found.

For fix mode, summarize the changes and verification, and identify unresolved or risky decisions. Match the response size to the work; a fixed report template or statistics table is not required.

## Review boundaries

Follow the codebase's conventions. Cross-reference other files when needed to verify usage or duplication, but report findings within the requested scope. Avoid presenting style preferences as defects.
