# theredbeard-pi-agent

Personal pi coding agent package — extensions, skills, themes, and prompts.

## Extensions

| Extension | Description |
|-----------|-------------|
| `answer.ts` | Interactive Q&A TUI for answering agent questions (Ctrl+.) |
| `context.ts` | `/context` — overview of loaded extensions, skills, token usage, and costs |
| `prompt-editor.ts` | Mode system (default/fast/precise) with per-mode model + thinking level (Ctrl+Space / Ctrl+Shift+M) |
| `files.ts` | `/files` — file browser with git status, session references, reveal/open/edit/diff (Ctrl+Shift+O) |
| `loop.ts` | `/loop` — iterative prompt loop until a breakout condition is met |
| `review.ts` | `/review` — code review for PRs, branches, commits, folders, or custom instructions (Ctrl+R) |
| `session-breakdown.ts` | `/session-breakdown` — GitHub-style usage analytics over 7/30/90 days |
| `todos.ts` | `/todos` — file-backed todo manager with TUI and agent tool |
| `fun-prompts.ts` | Replaces "Thinking..." with random fun messages |
| `walkthrough.ts` | `/walkthrough [path]` — walk through unstaged diff hunks one by one; agent explains each on demand |
| `datetime.ts` | `get_current_datetime` tool — returns current date, time, and timezone |
| `credential-scrubber.ts` | `scrub_credential` tool — detects and scrubs secrets from the session file on disk |
| `searxng.ts` | `web_search` tool — self-hosted SearXNG metasearch (set `SEARXNG_URL` env var) |
| `subagent/` | `subagent` tool — delegate tasks to specialized agents in single, parallel, or chain mode |
| `codex-cli-provider/` | Wraps the `codex` CLI as a pi model provider |

## Skills

| Skill | Description | Requires |
|-------|-------------|----------|
| `commit` | Conventional Commits-style git commits | git |
| `github` | GitHub via `gh` CLI (issues, PRs, runs, API) | `gh` |
| `web-browser` | CDP-based web browsing (Chrome DevTools Protocol) | Chrome/Chromium |
| `frontend-design` | Design and implement distinctive frontend interfaces | — |
| `mermaid` | Create and validate Mermaid diagrams | Node.js (npx) |
| `summarize` | URL/file → Markdown via `markitdown`, optional summarization | `uvx`, `markitdown` |
| `readability` | Score text readability against benchmarks for practitioner-grade technical writing | `textstat` (auto-installed) |

## Install

```bash
# From local path
pi install /path/to/theredbeard-pi-agent

# Or once published to npm
pi install npm:theredbeard-pi-agent
```

## Credits

Several extensions and skills adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (`mitsupi`).
