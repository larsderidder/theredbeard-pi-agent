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

## Skills

| Skill | Description | Requires |
|-------|-------------|----------|
| `commit` | Conventional Commits-style git commits | git |
| `github` | GitHub via `gh` CLI (issues, PRs, runs, API) | `gh` |
| `web-browser` | CDP-based web browsing (Chrome DevTools Protocol) | Chrome/Chromium |
| `frontend-design` | Design and implement distinctive frontend interfaces | — |
| `mermaid` | Create and validate Mermaid diagrams | Node.js (npx) |
| `summarize` | URL/file → Markdown via `markitdown`, optional summarization | `uvx`, `markitdown` |

## Install

```bash
# From local path
pi install /path/to/theredbeard-pi-agent

# Or once published to npm
pi install npm:theredbeard-pi-agent
```

## Credits

Several extensions and skills adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (`mitsupi`).
