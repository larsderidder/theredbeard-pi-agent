# theredbeard-pi-agent

Personal pi coding agent package: extensions, skills, themes, and prompts.

## Extensions

| Extension | Description |
|-----------|-------------|
| `answer.ts` | Interactive Q&A TUI for answering agent questions (Ctrl+.) |
| `context.ts` | `/context` — overview of loaded extensions, skills, token usage, and costs |
| `prompt-editor.ts` | Mode system (default/fast/precise) with per-mode model + thinking level (Ctrl+Space / Ctrl+Shift+M) |
| `files.ts` | `/files` — file browser with git status, session references, reveal/open/edit/diff (Ctrl+Shift+O) |
| `loop.ts` | `/loop` — iterative prompt loop until a breakout condition is met. Modes: `tests`, `todos [tag]`, `custom <condition>`, `self`, or pass a `.md`/`.loop` file path. File mode reads the full file as the task and extracts the breakout condition from a `## Breakout condition` section. `/loop-subagent <task.py> [param]` — isolated variant that spawns a fresh `pi -p --no-session` per iteration. The task script must implement three subcommands: `info [param]` (optional metadata), `queue [param]` (print next item + exit 0, or exit 1 when done), and `prompt <item> [param]` (print the full worker prompt). See `templates/loop-task-template.py` for a documented starter. |
| `lazy-tools.ts` | Native deferred tool loading through `search_tools`; `/lazy-tools` shows status or activates and resets domain bundles. |
| `review.ts` | `/review` — code review for PRs, branches, commits, folders, or custom instructions (Ctrl+R) |
| `session-breakdown.ts` | `/session-breakdown` — GitHub-style usage analytics over 7/30/90 days |
| `todos.ts` | `/todos` — file-backed todo manager with TUI and agent tool |
| `fun-prompts.ts` | Replaces "Thinking..." with random fun messages |
| `walkthrough.ts` | `/walkthrough [path]` — walk through unstaged diff hunks one by one; agent explains each on demand |
| `datetime.ts` | `get_current_datetime` tool — returns current date, time, and timezone |
| `kubectl.ts` | `kubectl_exec`, explicit-context Kubernetes commands with mutation approval, sensitive-output masking, and audit logging |
| `opengrep.ts` | `opengrep_check` tool for offline quality and security checks using `~/.local/bin/opengrep`, the pinned shared profile in `~/.config/opengrep/quality.json`, and additive project rules. Reports findings, rule provenance, coverage, skipped files, and scan failures; never applies autofixes. |
| `credential-scrubber.ts` | `scrub_credential` tool — detects and scrubs secrets from the session file on disk |
| `convert-local-document.ts` | `convert_local_document` tool, local rich document to Markdown conversion for absolute file paths only. Remote URLs are rejected. |
| `fork-terminal.ts` | `/fork-terminal`, `/clone-terminal`, `/btw2`, and `clone-terminal` / `loop-terminal` tools for launching pi sessions in new terminals. `/btw2 <task>` compacts large inherited context for the task before starting. |
| `terminal-title.ts` | Marks terminal titles as working, ready, or needing attention while preserving the session name and working directory |
| `notify.ts` | Completion notifications after the run settles. `raise_attention` records serious unresolved issues without stopping work; `resolve_attention` clears verified recovery. Outstanding issues get critical Kitty notifications at settlement and remain in session state until acknowledged or resolved. `/attention` lists issues, `/attention ack <id\|all>` marks them seen rather than fixed, and `/attention test` checks desktop delivery. |
| `move-session.ts` | `/move-session <directory>` — copy the current session history to another directory and switch to it |
| `session-peers.ts` | `session_peers` tool and `/session-peers` command for checking recent activity in related pi sessions |
| `projects.ts` | Persistent project manager with the `project` tool and `/project` or `/projects`; links todos and records contributing sessions |
| `worktree.ts` | `/worktree <name> [branch]` — create a sibling git worktree and switch the agent workflow to it |

### Opengrep project rules

The tool loads `.yaml` and `.yml` files recursively from `.opengrep/` under the scan target's nearest Git root, including worktrees. Outside Git, it uses the target directory or a file's parent directory. `projectRules` adds other local files or directories; relative paths resolve against the session directory.

```json
{"path": "/path/to/project", "projectRules": ["config/opengrep"]}
```

The shared baseline is always included. Its manifest selects files and directories, with explicit exclusions for auxiliary files or unwanted frameworks. With `namespace_rule_ids`, shared IDs are qualified by source file path in private temporary copies to preserve distinct upstream rules. Project IDs stay unchanged and cannot collide with those effective shared IDs. Patterns, metadata, and license notices are preserved; prepared copies are removed after scanning. Invalid rules, missing explicit paths, empty explicit rule directories, and symlinks fail the check. Each rule file is limited to 5 MiB. Results record project rule paths and SHA-256 hashes separately from the pinned shared profile; changing a project rule file during a scan fails the check.

Each scan runs through the POSIX `env` command with a private mode-0700 temporary directory assigned to `TMPDIR`, `TMP`, and `TEMP`. Cleanup removes the scanner's temporary files and prepared rule copies after success, errors, timeouts, or cancellation, without changing Pi's process-wide environment. Saved normalized reports remain outside this cleanup. A forced termination of Pi itself can bypass cleanup.

Finding messages come from configured rule templates, not the scanner's interpolated text. Native diagnostic text is omitted because it can also quote source; error codes remain available. This keeps matched values out of normalized results. Inspect detailed diagnostics locally when needed.

For standalone use, `node scripts/prepare-opengrep.mjs` prints the prepared directory on stdout and JSON selection metadata on stderr. It uses the same pinned loader without starting Pi or running analysis. Give both the preparer and scanner a private `TMPDIR`, pass the prepared directory to `opengrep scan --config`, retain `--no-rewrite-rule-ids --no-autofix`, and remove the private temporary directory after scanning. Opengrep can leave its own `semgrep-*.rules` copies behind even after successful scans, so removing only the prepared directory is insufficient. This preparation command requires Node 24 and a manifest enabling `namespace_rule_ids`.

## Skills

| Skill | Description | Requires |
|-------|-------------|----------|
| `commit` | Conventional Commits-style git commits | git |
| `github` | GitHub via `gh` CLI (issues, PRs, runs, API) | `gh` |
| `web-browser` | CDP-based web browsing (Chrome DevTools Protocol) | Chrome/Chromium |
| `frontend-design` | Design and implement distinctive frontend interfaces | — |
| `mermaid` | Create and validate Mermaid diagrams | Node.js (npx) |
| `summarize` | URL/file → Markdown via `markitdown`, optional summarization | `uvx`, `markitdown` |

Security routing keeps `code-security`, `llm-security`, and `security-scan` model-visible. Specialist audit skills remain available through `/skill:<name>` without occupying the default skill list.

## Internal libraries

`theredbeard-pi-agent/tool-permissions` exports `createApprovalGate()` for extension tools that need interactive mutation approval. It provides once, current agent run, and timed grants keyed by a caller-defined scope. It can reject or serialize concurrent operations, fails closed without UI, resets grants with session lifecycle events, and emits optional audit events.

Risk classification remains in the consuming extension. Callers must keep an allowed decision's lease until execution finishes and call `release()` in a `finally` block.

The Kubernetes extension requires `kubectl` and an operator-managed kubeconfig. Its optional policy stays local at `~/.pi/agent/kubectl-policy.json`; audit records default to `~/.pi/kubectl-audit.log`. Neither credentials nor cluster-specific configuration belongs in this package. The Bash guard catches recognizable direct kubectl commands, but is not a sandbox for arbitrary scripts or processes.

## Tests

```bash
npm test
npm run typecheck
npm run test:search-security
npm run test:search-security:live
npm run test:opengrep
npm run test:opengrep:live
```

## Install

```bash
# From local path
pi install /path/to/theredbeard-pi-agent

# Or once published to npm
pi install npm:theredbeard-pi-agent
```

## Credits

Several extensions and skills adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (`mitsupi`).
