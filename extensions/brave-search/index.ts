/**
 * Brave Search tool for pi.
 *
 * Provides web search via the Brave Search API.
 * Intended for use with the scout skill only.
 *
 * Requires BRAVE_API_KEY environment variable.
 *
 * Install globally: ~/.pi/agent/extensions/brave-search/
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

interface BraveSearchResult {
	title: string;
	url: string;
	description: string;
	age?: string;
}

interface BraveSearchResponse {
	query: { original: string };
	web?: {
		results: Array<{
			title: string;
			url: string;
			description: string;
			age?: string;
			language?: string;
		}>;
	};
}

export default function (pi: ExtensionAPI) {
	// Only allow brave_search when the scout skill is active, unless bypass is enabled.
	// Set BRAVE_SEARCH_ALWAYS_ENABLED=true to bypass the scout skill requirement.
	const alwaysEnabled = process.env.BRAVE_SEARCH_ALWAYS_ENABLED === "true";
	
	// Track whether scout was loaded this turn by watching the context.
	let scoutActive = false;

	pi.on("before_agent_start", async (event, _ctx) => {
		scoutActive = event.systemPrompt?.includes("# Scout") ?? false;
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "brave_search" && !scoutActive && !alwaysEnabled) {
			return {
				block: true,
				reason:
					"brave_search is only available via the scout skill. Use /skill:scout to activate it.",
			};
		}
	});

	pi.registerTool({
		name: "brave_search",
		label: "Brave Search",
		description:
			"Search the web using Brave Search. Returns titles, URLs, and descriptions for matching results. Use this for research tasks when you need to find information online.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(
				Type.Number({
					description: `Number of results to return (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT})`,
				})
			),
			freshness: Type.Optional(
				Type.String({
					description:
						'Filter by freshness: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year), or a date range like "2024-01-01to2024-02-01"',
				})
			),
		}),

		async execute(_toolCallId, params, signal) {
			const {
				query,
				count = DEFAULT_COUNT,
				freshness,
			} = params as {
				query: string;
				count?: number;
				freshness?: string;
			};

			if (!BRAVE_API_KEY) {
				return {
					content: [
						{
							type: "text" as const,
							text: "BRAVE_API_KEY environment variable is not set. Add it to your shell profile or .env file.",
						},
					],
					details: { error: "missing_api_key" },
					isError: true,
				};
			}

			const effectiveCount = Math.min(count, MAX_COUNT);

			const url = new URL(BRAVE_SEARCH_URL);
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(effectiveCount));
			if (freshness) {
				url.searchParams.set("freshness", freshness);
			}

			try {
				const response = await fetch(url.toString(), {
					headers: {
						Accept: "application/json",
						"Accept-Encoding": "gzip",
						"X-Subscription-Token": BRAVE_API_KEY,
					},
					signal,
				});

				if (!response.ok) {
					const body = await response.text();
					return {
						content: [
							{
								type: "text" as const,
								text: `Brave Search API error (${response.status}): ${body}`,
							},
						],
						details: {
							error: `http_${response.status}`,
							body,
						},
						isError: true,
					};
				}

				const data = (await response.json()) as BraveSearchResponse;
				const results: BraveSearchResult[] = (
					data.web?.results ?? []
				).map((r) => ({
					title: r.title,
					url: r.url,
					description: r.description,
					...(r.age ? { age: r.age } : {}),
				}));

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No results found for: ${query}`,
							},
						],
						details: { query, resultCount: 0 },
					};
				}

				const formatted = results
					.map((r, i) => {
						let line = `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`;
						if (r.age) {
							line += ` (${r.age})`;
						}
						return line;
					})
					.join("\n\n");

				const text = `## Search results for: ${query}\n\n${formatted}\n\n---\n${results.length} result${results.length === 1 ? "" : "s"} returned.`;

				return {
					content: [{ type: "text" as const, text }],
					details: {
						query,
						resultCount: results.length,
						results,
					},
				};
			} catch (error: any) {
				if (error.name === "AbortError") {
					return {
						content: [
							{
								type: "text" as const,
								text: "Search cancelled.",
							},
						],
						details: { error: "cancelled" },
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Brave Search failed: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});
}
