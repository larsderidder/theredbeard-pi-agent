import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_TOOL_NAME = "search_tools";

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
		aliases: ["kubernetes", "kubectl", "loki", "cluster", "pod logs", "infrastructure"],
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
			.sort()
			.slice(0, limit);
	}

	const terms = normalizeSearchText(query).split(" ").filter(Boolean);
	return lazyTools
		.map((tool) => ({ name: tool.name, score: lexicalScore(tool, terms) }))
		.filter((tool) => tool.score > 0)
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
			"Search for and activate tools that are loaded only when needed. Domains include browser automation, web research, personal history, shared documents, infrastructure, Godot, and occasional utilities.",
		promptSnippet: "Search for additional tools when the active tools cannot perform the task",
		promptGuidelines: [
			"Use search_tools when a task requires browser, research, personal-history, document, infrastructure, Godot, or utility tools that are not active.",
		],
		// ASVS 2.2.1: bound model-controlled search input and result count.
		parameters: Type.Object({
			query: Type.String({ description: "Capability or task to search for", maxLength: 500 }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),
		async execute(_toolCallId, params) {
			const matches = findMatchingTools(pi.getAllTools(), params.query, params.limit ?? 50);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No lazy tools found for: ${params.query}` }],
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
};
