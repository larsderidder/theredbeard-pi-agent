---
name: security-scan
description: "Security audit for application code, infrastructure, supply chain, and AI or agent systems. Use for unstaged changes, unpushed commits, specific paths, full repos, PR review, dependency risk, secrets, OWASP checks, Semgrep or Opengrep scans, SBOM, OpenSSF Scorecard, LLM apps, MCP servers, and agent tool safety. Report only."
---

# Security Scan

Produce an evidence-based security report and leave files unchanged. This skill coordinates scanners, upstream playbooks, and manual review, and should stay aligned with these sources:

- Semgrep `code-security`, `llm-security`, and `semgrep` skills: `https://github.com/semgrep/skills`
- OWASP Secure Agent Playbook: `https://github.com/OWASP/secure-agent-playbook`
- Netresearch security-audit skill: `https://github.com/netresearch/security-audit-skill`
- OWASP ASVS, OWASP API Security Top 10, OWASP LLM Top 10, OWASP AI Testing Guide, OWASP Top 10 for Agentic Applications 2026, OWASP Agentic Skills Top 10, and OWASP MCP Top 10
- OpenSSF Scorecard, OpenSSF OSPS Baseline, SLSA, Sigstore, and OpenSSF supply-chain guidance
- NIST SSDF, including SP 800-218A for generative AI and dual-use foundation model development
- Current GitHub Actions scanner research: combine complementary tools because no single scanner covers all workflow weaknesses

Consult sibling skills in this package when present, or the same skill names in the active Pi installation:

- Semgrep: `skills/code-security/SKILL.md`, `skills/llm-security/SKILL.md`, `skills/semgrep/SKILL.md`
- OWASP code security: `skills/code-review-security/SKILL.md`, `skills/sca-audit/SKILL.md`, `skills/secrets-scan/SKILL.md`, `skills/api-security-review/SKILL.md`, `skills/web-security-review/SKILL.md`, `skills/iac-security-review/SKILL.md`
- OWASP AI and agent security: `skills/agent-security-audit/SKILL.md`, `skills/agentic-ai-risk-assess/SKILL.md`, `skills/llm-risk-assess/SKILL.md`, `skills/mcp-server-review/SKILL.md`, `skills/prompt-injection-test/SKILL.md`, `skills/multi-agentic-threat-model/SKILL.md`

## Scope

Parse the user's request and clarify the scope when needed.

| Scope | Files |
|-------|-------|
| **unstaged** | `git diff --name-only` |
| **unpushed** | `git log --name-only --pretty=format: @{u}..HEAD \| sort -u`, fallback to `origin/main..HEAD` |
| **path** | User-provided files, directories, or globs |
| **all** | `git ls-files` |

Filter to relevant source, config, dependency, CI, IaC, container, and agent files. If the target exceeds 200 files, ask to narrow the scope unless the user explicitly asked for a full scan.

## Run order

Use the fastest high-signal checks first. If a tool is missing, note it and continue.

1. **Inventory:** identify languages, frameworks, package managers, lockfiles, Dockerfiles, CI workflows, Terraform, Kubernetes, MCP config, agent instructions, and model or RAG code.
2. **Automated scans:** run available tools from the checklist below.
3. **Manual review:** trace trust boundaries, user input, auth decisions, sensitive data, and dangerous sinks.
4. **Agent and AI review:** only when the repo uses LLMs, agents, tools, MCP, RAG, embeddings, model hosting, or prompt files.
5. **Triage:** remove false positives, then keep only findings with evidence and a plausible exploit path.

## Automated checks

Prefer these tools when available:

| Area | Preferred tools |
|------|-----------------|
| SAST | `semgrep --config auto`, `semgrep --config p/owasp-top-ten`, or `opengrep` equivalents |
| Secrets | `gitleaks detect --no-banner --redact`, `trufflehog filesystem --no-update` |
| Dependencies | `osv-scanner`, `npm audit`, `pnpm audit`, `yarn audit`, `pip-audit`, `govulncheck`, `cargo audit` |
| Containers and IaC | `trivy fs`, `trivy config`, `checkov`, `tfsec`, `kubesec` |
| SBOM and supply chain | `syft`, `grype`, `trivy fs --format cyclonedx`, `cosign verify`, `slsa-verifier`, OpenSSF Scorecard |
| GitHub Actions | `actionlint`, `zizmor`, `poutine`, `frizbee`, Semgrep rules, and manual checks for untrusted interpolation, permissions, and pinned actions |
| DAST and exposure checks | `nuclei`, only for owned or explicitly authorized targets |
| LLM or agent apps | OWASP Secure Agent Playbook skills, OWASP Agentic Skills Top 10 checks, OWASP MCP Top 10 checks, `agent-audit` for Python agent or MCP projects, and Semgrep rules where relevant |

Use JSON output when practical, but do not dump raw scanner output into the final report. Summarize and cite the command used.

## Manual checklist

### Code and web security

- Broken access control: missing route guards, object-level auth failures, confused admin/user boundaries
- Injection: SQL, NoSQL, command, LDAP, template, expression language, XML, prompt, tool-call, and log injection
- XSS and output handling: unsafe HTML rendering, DOM sinks, markdown rendering, missing CSP
- SSRF and network pivots: user-controlled URLs, metadata access, internal service reachability
- Path traversal and file upload: unsafe paths, archive extraction, MIME trust, public upload execution
- Deserialization and code execution: `eval`, dynamic imports, pickle, YAML object loading, PHP unserialize, Java deserialization
- Auth and sessions: JWT verification, expiry, algorithm confusion, password hashing, CSRF, cookie flags, OAuth redirect handling
- Crypto: weak randomness, MD5 or SHA1 for security, custom crypto, bad key storage, missing TLS validation
- Data exposure: PII in logs, tokens in URLs, overly broad API responses, stack traces, verbose errors

### Infrastructure and CI

- Docker runs as root, unpinned images, leaked build args, privileged containers
- Kubernetes privileged pods, host mounts, missing resource limits, weak RBAC, secrets in manifests
- Terraform public buckets, wide IAM, missing encryption, public databases, permissive security groups
- GitHub Actions untrusted `${{ github.event.* }}` or `${{ inputs.* }}` inside `run`, broad `permissions`, unpinned third-party actions
- CI jobs that process pull request metadata, branch names, commit messages, tags, or manual workflow inputs without quoting and validation
- Privileged CI credentials reachable from untrusted code snapshots
- GitHub Actions artifact integrity gaps, privileged triggers, weak `GITHUB_TOKEN` scopes, unverified downloaded artifacts, floating action refs, and broad `secrets: inherit`

### Supply chain and OSPS Baseline

Use OpenSSF OSPS Baseline as the repo posture checklist, with Scorecard as the automated starting point.

- Known CVEs in direct and transitive dependencies
- Lockfile absent or drifted from manifests
- Install scripts from untrusted packages
- Unpinned base images and actions
- Missing SBOM for release artifacts when the project ships software
- Missing release signatures, provenance, attestations, or published hashes for released assets
- Published artifacts that cannot be verified with Sigstore, SLSA provenance, checksums, or equivalent attestations
- Missing `SECURITY.md`, private vulnerability reporting path, security contacts, or remediation policy
- Weak repository controls: no MFA expectation, weak branch protection, no required checks, no non-author review for important changes
- Missing contributor guidance, build-from-source documentation, dependency policy, or support window
- Public repos: run OpenSSF Scorecard or note why it was not possible

### AI, LLM, MCP, and agent systems

Use OWASP LLM Top 10, OWASP AI Testing Guide, OWASP Secure Agent Playbook, OWASP Top 10 for Agentic Applications 2026, and OWASP Agentic Skills Top 10.

Check:

- Prompt injection boundaries: untrusted content is separated from instructions, tools do not trust model text blindly
- Tool permissions: least privilege, read/write separation, confirmation for destructive or external actions
- Secret handling: secrets never enter prompts, logs, vector stores, tool output, or user-visible traces
- RAG and embeddings: tenant isolation, permission-aware retrieval, source attribution, stale or poisoned document handling
- MCP servers and tools: auth, transport security, command allowlists, file access scope, schema validation
- MCP protocol risks: token exposure, scope creep, tool poisoning, dependency tampering, command execution, intent flow subversion, missing auth, missing telemetry, shadow servers, and context over-sharing
- Memory and state: poisoning, cross-user leakage, persistence of untrusted instructions
- Excessive agency: spending limits, rate limits, execution timeouts, human approval gates, audit logs
- Model supply chain: model provenance, unsafe deserialization of model files, dependency and plugin verification
- Output handling: model output is treated as untrusted before SQL, shell, HTML, file paths, API calls, or tool calls
- Agent skills: malicious instructions, over-broad file or network scope, unsafe metadata, update drift, weak isolation, missing inventory, and missing approval workflow
- Skill packages: untrusted scripts, writes to identity or memory files, hidden network egress, registry provenance gaps, and missing version pinning

## Severity

Use CRITICAL, HIGH, MEDIUM, LOW, or INFO.

Critical and high findings need a concrete attack scenario: who can exploit it, what they do, and what they gain. Lower severity findings still need a file, line, and fix.

## Output

```markdown
# Security Scan Report

**Scope**: [what was scanned]
**Files**: [count]
**Commands run**: [scanner commands or "manual only"]
**Findings**: [count by severity]

## Summary
[2 or 3 sentences: biggest risks, overall posture]

## Findings

### CRITICAL
#### [Title]
- **Location**: file:line
- **Evidence**: [specific code or scanner evidence, do not print secrets]
- **Impact**: [what an attacker gains]
- **Attack scenario**: [required for critical and high]
- **References**: [CWE, OWASP, CVE, OpenCRE, scanner rule]
- **Remediation**: [specific fix]

### HIGH
[same structure]

### MEDIUM
[same structure, attack scenario optional]

### LOW
[same structure, attack scenario optional]

### INFO
[hardening notes]

## Tool coverage
| Check | Tool | Result |
|-------|------|--------|
| SAST | semgrep | clean / findings / not installed |
| Secrets | gitleaks / trufflehog | clean / findings / not installed |
| Dependencies | osv-scanner / pip-audit / govulncheck / ecosystem audit | clean / findings / not installed |
| Containers and IaC | trivy / checkov | clean / findings / not installed |
| GitHub Actions | actionlint / zizmor / poutine / frizbee / Semgrep | clean / findings / not installed |
| Supply chain | scorecard / syft / grype / cosign / slsa-verifier | clean / findings / not applicable |
| DAST and exposure checks | nuclei | clean / findings / not applicable |
| LLM or agent apps | OWASP Secure Agent Playbook / agent-audit | clean / findings / not applicable |
```

## Reporting rules

- Do not print secret values. Show file and line, plus a redacted prefix only if needed.
- Do not report scanner findings that are clearly false positives.
- Do not report mitigated patterns. Parameterized SQL is not SQL injection. Escaped output is not XSS.
- If no meaningful attack surface exists, say that and stop after the tool coverage table.
- If a tool is missing, mark that check as not run and continue.
