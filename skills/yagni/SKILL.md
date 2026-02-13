---
name: yagni
description: "Find what can be removed, inlined, or collapsed without losing functionality. YAGNI enforcer. Answers the question: what can we pull out and still be alright? Report only, never edits files."
---

# Simplify

Find things to remove. Report only. Never edit files.

## Scope

Parse the user's request. Ask if unclear.

| Scope | Files |
|-------|-------|
| **unstaged** | `git diff --name-only` |
| **unpushed** | `git log --name-only --pretty=format: @{u}..HEAD \| sort -u` (fall back to `origin/main..HEAD`) |
| **path** | User-provided files, directories, or globs |
| **all** | `git ls-files` |

Filter to source files only. If >200 files, confirm or suggest narrowing.

## Checks

Present the list and let the user pick. If already specified, use those without asking.

### 1. Unused Features
Code paths nobody triggers: endpoints nothing calls, UI paths behind flags nobody enables, event handlers for events that never fire. Verify by tracing call sites across the full project.

### 2. Over-abstraction
Interfaces with one implementation. Factories that produce one thing. Base classes with one subclass. Indirection layers that exist "for flexibility" but have never been extended. The test: if you inlined it, would anything get harder?

### 3. Premature Generics
Code handling cases that do not exist yet. Type parameters that are always the same concrete type. Config options that are always set to the same value. Switches and strategies with one branch.

### 4. Dependency Bloat
Libraries imported for a single function that could be written in a few lines. Multiple libraries doing the same job. Dependencies pulled in transitively that are only used shallowly.

### 5. Dead Configuration
Env vars that are always the same value across all environments. Feature flags that have been on (or off) forever. Config keys that nothing reads. Default values that are never overridden.

### 6. Wrapper Layers
Thin wrappers that pass through to what they wrap without adding behavior. Service classes that just call another service. Utility functions that are one-line aliases for a standard library call.

## Output

```
# Simplification Report

**Scope**: [what was analyzed]
**Files**: [count]
**Candidates**: [count]

## Summary
[2-3 sentences: what stands out, estimated weight that could be dropped]

## Candidates

### High Confidence (safe to remove now)
[file:line, what it is, why it's removable, what to verify before deleting]

### Moderate Confidence (likely removable, needs a closer look)
[file:line, what it is, why it looks removable, what makes it uncertain]

### Low Confidence (smells unnecessary, but risky)
[file:line, what it is, concern, what could break]

## Stats
| Check | Candidates |
|-------|------------|
| ... | ... |
```

## Principles

- Every candidate references a specific file and line.
- Use absolute counts, not percentages.
- Confidence matters more than severity here. Group by how safe removal is, not how bad the code is.
- Always state what to verify before removing. "Delete X" is not enough; "delete X, then check Y still works" is.
- Do not flag things that are small and harmless. A one-line unused helper is not worth reporting. Focus on weight: lines saved, dependencies dropped, concepts removed.
- If the codebase is already lean, say so and stop.
