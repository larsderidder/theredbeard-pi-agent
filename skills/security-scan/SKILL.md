---
name: security-scan
description: "Security audit for application code. Dependency vulnerabilities, OWASP code patterns, secrets, auth gaps, and injection risks. Scope to unstaged changes, unpushed commits, specific paths, or the full codebase. Report only."
---

# Security Scan

Find security issues. Report only. Never edit files.

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

### 1. Dependency Vulnerabilities
Detect project type from lockfiles/manifests, then run the appropriate audit tool:

| File | Tool |
|------|------|
| `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` | `npm audit --json` / `yarn audit --json` / `pnpm audit --json` |
| `requirements.txt` / `Pipfile.lock` / `pyproject.toml` | `pip-audit --format json` |
| `go.mod` | `govulncheck -json ./...` |
| `Cargo.toml` | `cargo audit --json` |

If the tool is not installed, say so and move on. Do not block the rest of the scan. Report each CVE with package name, current version, fixed version, and severity.

### 2. Secrets and Credentials
Hardcoded API keys, tokens, passwords, connection strings, private keys. Check for common patterns: high-entropy strings assigned to variables named `secret`, `key`, `token`, `password`, `credential`; `.env` files or dotenv values committed to the repo; private keys (`-----BEGIN`). Flag the file and line; do not print the actual secret value in the report.

### 3. Injection Risks
SQL injection (string concatenation in queries), XSS (unsanitized user input rendered in HTML/templates), command injection (`exec`, `spawn`, `system` with user-controlled input), path traversal (user input in file paths without sanitization), template injection. Trace user input to the dangerous sink; do not flag parameterized queries or properly escaped output.

### 4. Authentication and Authorization
Missing auth checks on routes/endpoints, overly permissive CORS, session misconfiguration, JWT issues (no expiry, weak algorithm, secret in code), broken access control (horizontal/vertical privilege escalation paths), insecure password handling (plaintext, weak hashing).

### 5. Insecure Defaults and Configuration
Debug mode enabled in production config, verbose error messages that leak internals, permissive file permissions, HTTP instead of HTTPS, missing security headers (CSP, HSTS, X-Frame-Options), insecure cookie settings (missing Secure/HttpOnly/SameSite).

### 6. Data Exposure
Sensitive data in logs, stack traces returned to clients, PII in URLs or query strings, overly broad API responses that include fields the client should not see, missing encryption for data at rest or in transit.

## Output

```
# Security Scan Report

**Scope**: [what was scanned]
**Files**: [count]
**Findings**: [count by severity]

## Summary
[2-3 sentences: biggest risks, overall posture]

## Findings

### Critical
[file:line, what the issue is, attack scenario, remediation]

### High
[file:line, what the issue is, attack scenario, remediation]

### Medium
[file:line, what the issue is, remediation]

### Low
[file:line, what the issue is, remediation]

## Stats
| Check | Findings |
|-------|----------|
| ... | ... |
```

## Principles

- Every finding references a specific file and line (except dependency CVEs, which reference the package).
- Use absolute counts, not percentages.
- For each critical and high finding, describe a concrete attack scenario: who could exploit this, how, and what they gain.
- Do not flag properly mitigated patterns. Parameterized queries are not SQL injection. Escaped output is not XSS.
- If a tool is missing, skip that check and note it. Do not fail the whole scan.
- If the codebase has no security-relevant surface (e.g., a pure CLI utility with no network, no auth, no user input), say so and stop.
