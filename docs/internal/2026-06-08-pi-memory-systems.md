# Pi memory systems notes

Date: 2026-06-08

## Immediate change

The `remember` tool should be the fallback after source-adjacent places have been checked for durable notes.

Preferred order:

1. Put technical guidance near the thing it explains: scripts, comments, README files, AGENTS.md, docs/internal notes, clear entry points, or tool and extension descriptions.
2. Use project memory only for codebase-specific domain facts, business context, or decisions that do not belong near source code.
3. Use global memory only for stable personal, domain, or business facts that apply across projects.

This keeps context discoverable by future agents without building a hidden pile of instructions that drift away from the source.

## Systems worth learning from

### Anthropic memory tool

The AI SDK docs describe Anthropic's memory tool as a structured interface over a `/memories` directory. It supports commands such as view, create, string replacement, insert, delete, and rename, with paths scoped to that directory.

What to copy:

- A filesystem shape is easier for agents to inspect than an append-only flat file.
- `view` before edit encourages careful updates.
- Scoped paths make safety and review simpler.

Fit for pi: high. We could expose a structured memory directory under `.pi/context/` or `.pi/memories/`, but only if we keep technical notes source-adjacent by default.

### AI SDK memory taxonomy

The AI SDK groups memory integrations into provider-defined tools, memory providers, and custom tools.

What to copy:

- Keep pi's memory extension custom and explicit. Provider-defined tools create lock-in.
- Memory providers are convenient, but they hide retrieval and storage behavior.
- A custom tool lets pi keep confirmation, paths, and policy under our control.

Fit for pi: high as design framing.

### LangGraph and LangMem

LangGraph separates short-term thread memory from long-term cross-thread memory. LangMem adds semantic, episodic, and procedural memory, plus two write modes: hot path and background.

What to copy:

- Distinguish memory types instead of treating every fact the same.
- Use namespaces by project, user, client, or application.
- Prefer background reflection for summaries, because hot-path memory writes slow the agent and distract it.
- Treat procedural memory as source artifacts when possible: prompts, tools, comments, scripts, and AGENTS.md.

Fit for pi: high. This maps well to sessions, project roots, and extension hooks.

### Letta

Letta separates core memory blocks, which are pinned into context, from archival memory, which is searched on demand. It also keeps conversation history separately.

What to copy:

- Keep always-in-context memory tiny and curated.
- Move larger material to searchable archives.
- Separate intentional facts from raw conversation search.
- Allow shared memory blocks when several agents need the same standing context.

Fit for pi: medium to high. The current Markdown files act like core memory, but there is no archival layer yet.

### Mem0 and OpenMemory

Mem0 provides a memory layer as a library, managed platform, or self-hosted server. It can extract memories, retrieve relevant ones, and provide dashboards or audit logs. OpenMemory was the local MCP version, but its README now says it is being sunset in favor of the Mem0 self-hosted server.

What to copy:

- Dashboard and audit log ideas are useful.
- Self-hosted mode is preferable if personal memory is involved.
- Automatic extraction is useful only with strong review and delete flows.

Fit for pi: medium. Useful to learn from, but probably too heavy for the basic pi memory extension.

### Zep and Graphiti

Graphiti is Zep's open-source temporal context graph engine. It stores entities, relationships, facts, and episodes with provenance and temporal validity windows. Retrieval combines semantic, keyword, and graph search.

What to copy:

- Provenance matters. Every remembered fact should say where it came from.
- Facts change. Invalidation beats blind accumulation.
- Temporal queries are important for real work memory.

Fit for pi: medium. Great model for a richer research or project-memory layer, probably overkill for simple preferences.

### Cognee

Cognee exposes a simple memory lifecycle: remember, recall, improve, forget. It builds graph memory from text, files, or URLs and supports both session memory and permanent graph memory.

What to copy:

- The four verbs are a clean interface.
- `improve` is a useful explicit operation for consolidation, not just append and forget.
- Session memory should be easy to bridge into permanent memory only after review.

Fit for pi: medium.

### Supermemory

Supermemory provides AI SDK middleware for automatic profile injection and tools for search, add, and fetch. It scopes memories with stable user or container tags and conversation IDs.

What to copy:

- Memory can be middleware, not only a tool.
- Scope every read and write with a stable namespace.
- Error handling should degrade gracefully and continue without memory if retrieval fails.

Fit for pi: medium.

### Hindsight

Hindsight stores information in memory banks. It has retain, recall, and reflect operations, plus mental models, observations, world facts, and experience facts. Retrieval combines semantic, keyword, graph, and temporal strategies.

What to copy:

- Memory banks with mission and directives are interesting for client or project-specific agents.
- Observations consolidate raw facts while preserving evidence.
- Multi-strategy retrieval is better than vector-only search.

Fit for pi: medium to high if we build a serious local memory service.

## Recommendation

For pi, do not start by adding a big memory provider. First tighten the current local extension:

1. Keep global and project memory small.
2. Make `remember` harder to misuse through description, confirmation copy, and perhaps a policy check.
3. Add provenance to memory entries: source session, date, project root, and user confirmation.
4. Add an audit command that finds stale or technical entries and suggests moving them near source.
5. Add a searchable archive only after the small always-in-context memory is under control.

The likely next useful feature is not vector search. It is a better write policy and a way to move memories out of memory when they belong in source-controlled context.
