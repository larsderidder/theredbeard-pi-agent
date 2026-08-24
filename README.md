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
| `credential-scrubber.ts` | `scrub_credential` tool — detects and scrubs secrets from the session file on disk |
| `convert-local-document.ts` | `convert_local_document` tool, local rich document to Markdown conversion for absolute file paths only. Remote URLs are rejected. |
| `fork-terminal.ts` | `/fork-terminal`, `/clone-terminal`, `/btw`, and `clone-terminal` / `loop-terminal` tools for launching pi sessions in new terminals |
| `move-session.ts` | `/move-session <directory>` — copy the current session history to another directory and switch to it |
| `session-peers.ts` | `session_peers` tool and `/session-peers` command for checking recent activity in related pi sessions |
| `projects.ts` | Persistent project manager with the `project` tool and `/project` or `/projects`; links todos and records contributing sessions |
| `worktree.ts` | `/worktree <name> [branch]` — create a sibling git worktree and switch the agent workflow to it |

## Skills

| Skill | Description | Requires |
|-------|-------------|----------|
| `commit` | Conventional Commits-style git commits | git |
| `github` | GitHub via `gh` CLI (issues, PRs, runs, API) | `gh` |
| `web-browser` | CDP-based web browsing (Chrome DevTools Protocol) | Chrome/Chromium |
| `frontend-design` | Design and implement distinctive frontend interfaces | — |
| `mermaid` | Create and validate Mermaid diagrams | Node.js (npx) |
| `summarize` | URL/file → Markdown via `markitdown`, optional summarization | `uvx`, `markitdown` |

## Tests

```bash
npm test
npm run typecheck
npm run test:search-security
npm run test:search-security:live
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
