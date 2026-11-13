import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_TOOL_NAME = "search_tools";
const DEFAULT_LEXICAL_LIMIT = 8;
const MIN_LEXICAL_SCORE = 1;
const LEXICAL_STOP_WORDS = new Set([
	"a",
	"active",
	"an",
	"and",
	"by",
	"call",
	"calls",
	"capability",
	"command",
	"commands",
	"file",
	"files",
	"find",
	"for",
	"from",
	"get",
	"in",
	"load",
	"loaded",
	"local",
	"mode",
	"model",
	"my",
	"of",
	"on",
	"or",
	"our",
	"pi",
	"task",
	"the",
	"to",
	"tool",
	"tools",
	"use",
	"using",
	"with",
	"without",
	"your",
]);

interface ToolGroup {
	name: string;
	aliases: string[];
	matches: (toolName: string) => boolean;
}

const PERSONAL_HISTORY_TOOLS = new Set([
	"browse_history_by_date",
	"gdrive_info",
	"gdrive_list_folder",
	"gdrive_read",
	"read_gmail_attachment",
	"read_gmail_message",
	"search_browser",
	"search_calendar",
	"search_gdrive",
	"search_git",
	"search_gmail",
	"search_hushnote",
	"search_pi_sessions",
	"search_protonmail",
	"search_shell",
	"search_windows",
	"summarize_git",
]);

const UTILITY_TOOLS = new Set([
	"bryti_notify",
	"clipboard_write",
	"clone-terminal",
	"convert_local_document",
	"loop-terminal",
	"schedule",
	"screenshot",
	"tether_attach",
]);

const TOOL_GROUPS: ToolGroup[] = [
	{
		name: "browser",
		aliases: ["browser automation", "control browser", "open browser", "webpage", "website interaction", "click page", "fill form"],
		matches: (toolName) => toolName.startsWith("browser_"),
	},
	{
		name: "web-research",
		aliases: ["web search", "internet search", "internet research", "argus", "extract url", "recover url"],
		matches: (toolName) => toolName === "web_search" || toolName === "web_extract" || toolName.startsWith("argus_"),
	},
	{
		name: "personal-history",
		aliases: ["personal history", "history", "gmail", "calendar", "google drive", "drive", "protonmail", "meeting notes"],
		matches: (toolName) => PERSONAL_HISTORY_TOOLS.has(toolName),
	},
	{
		name: "documents",
		aliases: ["outline", "hedgedoc", "wiki", "shared notes"],
		matches: (toolName) => toolName.startsWith("outline_") || toolName.startsWith("hedgedoc_"),
	},
	{
		name: "infrastructure",
		aliases: ["kubernetes", "k8s", "kubectl", "loki", "cluster", "pod logs", "infrastructure"],
		matches: (toolName) => toolName === "kubectl_exec" || toolName.startsWith("loki_query_"),
	},
	{
		name: "godot",
		aliases: ["godot", "game project"],
		matches: (toolName) => toolName.startsWith("godot_"),
	},
	{
		name: "utilities",
		aliases: ["clipboard", "notify phone", "schedule reminder", "tether", "clone terminal", "convert document"],
		matches: (toolName) => UTILITY_TOOLS.has(toolName),
	},
];

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function groupForTool(toolName: string): string | undefined {
	for (const group of TOOL_GROUPS) {
		if (group.matches(toolName)) {
			return group.name;
		}
	}
	return undefined;
}

function matchingGroupNames(query: string): Set<string> {
	const normalizedQuery = ` ${normalizeSearchText(query)} `;
	const matches = new Set<string>();
	for (const group of TOOL_GROUPS) {
		for (const alias of group.aliases) {
			const normalizedAlias = ` ${normalizeSearchText(alias)} `;
			if (normalizedQuery.includes(normalizedAlias)) {
				matches.add(group.name);
				break;
			}
		}
	}
	return matches;
}

function lexicalTerms(query: string): string[] {
	const terms = normalizeSearchText(query).split(" ");
	return [...new Set(terms)].filter((term) => term.length > 1 && !LEXICAL_STOP_WORDS.has(term));
}

function lexicalScore(tool: Pick<ToolInfo, "name" | "description">, terms: string[]): number {
	const normalizedName = normalizeSearchText(tool.name);
	const normalizedDescription = normalizeSearchText(tool.description);
	let score = 0;
	for (const term of terms) {
		if (normalizedName.includes(term)) {
			score += 3;
		}
		if (normalizedDescription.includes(term)) {
			score += 1;
		}
	}
	return score;
}

function findMatchingTools(
	tools: Array<Pick<ToolInfo, "name" | "description">>,
	query: string,
	limit: number,
): string[] {
	const lazyTools = tools.filter((tool) => groupForTool(tool.name) !== undefined);
	const groupMatches = matchingGroupNames(query);
	if (groupMatches.size > 0) {
		return lazyTools
			.filter((tool) => groupMatches.has(groupForTool(tool.name) ?? ""))
			.map((tool) => tool.name)
			.sort();
	}

	const terms = lexicalTerms(query);
	return lazyTools
		.map((tool) => ({ name: tool.name, score: lexicalScore(tool, terms) }))
		.filter((tool) => tool.score >= MIN_LEXICAL_SCORE)
		.sort((left, right) => {
			if (left.score !== right.score) {
				return right.score - left.score;
			}
			return left.name.localeCompare(right.name);
		})
		.slice(0, limit)
		.map((tool) => tool.name);
}

function initialActiveTools(pi: ExtensionAPI): string[] {
	return pi.getActiveTools().filter((toolName) => groupForTool(toolName) === undefined);
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => String((block as { text?: unknown }).text ?? ""))
		.join("\n");
}

// pi core answers a call to a registered-but-inactive tool with this exact error.
const TOOL_NOT_FOUND_PATTERN = /^Error: Tool '(.+)' not found$/;

function notFoundToolName(content: unknown): string | undefined {
	return TOOL_NOT_FOUND_PATTERN.exec(textOfContent(content).trim())?.[1];
}

function toolSearchNoMatchHint(): string {
	const domains = TOOL_GROUPS.map((group) => group.name).join(", ");
	return [
		"",
		"Note: tool_search only searches deferred MCP tools and never finds lazy tools.",
		`Lazy tools (registered but inactive, for example kubectl_exec) are activated with the ${SEARCH_TOOL_NAME} tool instead.`,
		`Try a domain keyword: ${domains}. For example call ${SEARCH_TOOL_NAME} with query "infrastructure" or "kubectl" to load kubectl_exec.`,
	].join("\n");
}

function appendHintToContent(content: unknown, hint: string): unknown {
	if (typeof content === "string") return `${content}${hint}`;
	if (!Array.isArray(content)) return [{ type: "text", text: hint }];
	const blocks = [...content];
	const lastText = [...blocks].reverse().find((block) => {
		return block && typeof block === "object" && (block as { type?: string }).type === "text";
	}) as { text?: string } | undefined;
	if (lastText) lastText.text = `${lastText.text ?? ""}${hint}`;
	else blocks.push({ type: "text", text: hint });
	return blocks;
}

function activateTools(pi: ExtensionAPI, toolNames: string[]): string[] {
	const active = pi.getActiveTools();
	const added = toolNames.filter((toolName) => !active.includes(toolName));
	pi.setActiveTools([...new Set([...active, ...added])]);
	return added;
}

export default function lazyToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SEARCH_TOOL_NAME,
		label: "Search Tools",
		description:
			"Search for and activate lazy tools: tools that are registered but stay inactive until activated here. Domains include browser automation, web research, personal history, shared documents, infrastructure, Godot, and utilities. Note: the harness tool_search tool only searches deferred MCP tool metadata and never finds these lazy tools; use this search_tools tool for them.",
		promptSnippet: "Search for and activate lazy tools (such as kubectl_exec) when the active tools cannot perform the task",
		promptGuidelines: [
			"Use search_tools when a task requires browser, research, personal-history, document, infrastructure, Godot, or utility tools that are not active. Query with a domain keyword; for example \"infrastructure\" or \"kubectl\" loads kubectl_exec.",
			"Do not use the harness tool_search tool for lazy tools such as kubectl_exec; it only covers deferred MCP tools and reports no matches for them.",
		],
		// ASVS 2.2.1: bound model-controlled search input and result count.
		parameters: Type.Object({
			query: Type.String({ description: "Capability or task to search for", maxLength: 500 }),
			limit: Type.Optional(Type.Integer({
				description: "Maximum lexical matches. Explicit domain bundles may contain more tools.",
				minimum: 1,
				maximum: 25,
			})),
		}),
		async execute(_toolCallId, params) {
			const matches = findMatchingTools(pi.getAllTools(), params.query, params.limit ?? DEFAULT_LEXICAL_LIMIT);
			if (matches.length === 0) {
				const domains = TOOL_GROUPS.map((group) => group.name).join(", ");
				return {
					content: [{
						type: "text",
						text: `No lazy tools found for: ${params.query}\n\nAvailable lazy tool domains: ${domains}. Try a domain keyword, for example "infrastructure" or "kubectl" (loads kubectl_exec).`,
					}],
					details: { matches: [], added: [] },
				};
			}

			const added = activateTools(pi, matches);
			let text = `Matching tools already active: ${matches.join(", ")}`;
			if (added.length > 0) {
				text = `Loaded tools: ${added.join(", ")}`;
			}
			return {
				content: [{ type: "text", text }],
				details: { matches, added },
			};
		},
	});

	pi.on("session_start", () => {
		pi.setActiveTools([...new Set([...initialActiveTools(pi), SEARCH_TOOL_NAME])]);
	});

	// Self-heal direct calls to an inactive lazy tool: pi core answers those with
	// "Error: Tool '<name>' not found" before the tool is resolved. Activate the tool so
	// the next model call sees it, and rewrite the error in place (the event result is
	// passed by reference) so the model knows to simply call the tool again.
	pi.on("tool_execution_end", (event) => {
		if (!event.isError) return;
		const name = notFoundToolName(event.result?.content);
		if (!name || groupForTool(name) === undefined) return;
		if (pi.getActiveTools().includes(name)) return;
		activateTools(pi, [name]);
		const replacement = `Error: Tool '${name}' is a lazy tool that was not active. It has been activated automatically; call ${name} again.`;
		const content = event.result?.content;
		if (typeof content === "string") {
			event.result.content = replacement;
		} else if (Array.isArray(content)) {
			const textBlock = content.find((block) => {
				return block && typeof block === "object" && (block as { type?: string }).type === "text";
			}) as { text?: string } | undefined;
			if (textBlock) textBlock.text = replacement;
			else content.push({ type: "text", text: replacement });
		}
	});

	// When the harness tool_search (deferred MCP metadata only) reports no matches, point
	// the model at search_tools, which is the router that actually finds lazy tools.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "tool_search") return;
		if (!textOfContent(event.content).includes("No matching tools found.")) return;
		const active = new Set(pi.getActiveTools());
		const hasInactiveLazy = pi.getAllTools().some((tool) => groupForTool(tool.name) !== undefined && !active.has(tool.name));
		if (!hasInactiveLazy) return;
		return { content: appendHintToContent(event.content, toolSearchNoMatchHint()) as typeof event.content };
	});

	pi.registerCommand("lazy-tools", {
		description: "Show lazy tool groups, or use reset/all to change activation",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const allLazyTools = pi.getAllTools()
				.filter((tool) => groupForTool(tool.name) !== undefined)
				.map((tool) => tool.name);
			if (action === "all") {
				const added = activateTools(pi, allLazyTools);
				ctx.ui.notify(`Activated ${added.length} lazy tools.`, "info");
				return;
			}
			if (action === "reset") {
				pi.setActiveTools([...new Set([...initialActiveTools(pi), SEARCH_TOOL_NAME])]);
				ctx.ui.notify("Lazy tool activation reset.", "info");
				return;
			}

			const active = new Set(pi.getActiveTools());
			const lines = TOOL_GROUPS.map((group) => {
				const groupTools = allLazyTools.filter((toolName) => groupForTool(toolName) === group.name);
				const activeCount = groupTools.filter((toolName) => active.has(toolName)).length;
				return `${group.name}: ${activeCount}/${groupTools.length} active`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export const lazyToolsTestApi = {
	findMatchingTools,
	groupForTool,
	notFoundToolName,
	toolSearchNoMatchHint,
	appendHintToContent,
};
