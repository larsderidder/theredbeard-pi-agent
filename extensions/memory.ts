/**
 * Memory Extension
 *
 * Gives pi persistent memory across sessions at two scopes:
 *
 *   Global  ~/.pi/agent/MEMORY.md   — preferences, style, cross-project facts
 *   Project .pi/MEMORY.md           — facts specific to the current codebase
 *
 * On agent_start both files are injected into the system prompt so every turn
 * has access to them from the very first message.
 *
 * The LLM can call the `remember` tool to append a fact to either scope. The
 * user is asked to confirm before anything is written.
 *
 * Self-cleaning runs on agent_start: bullet points that are exact duplicates
 * of another entry in the same file are removed. This keeps the files tidy
 * even after many sessions of accumulated notes.
 *
 * Commands:
 *   /memory          — Open an interactive viewer/editor for both memory files
 *   /memory-forget   — Interactively remove a specific entry from a memory file
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Markdown, Text, matchesKey } from "@mariozechner/pi-tui";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function globalMemoryPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "MEMORY.md");
}

function projectMemoryPath(cwd: string): string {
	return path.join(cwd, ".pi", "MEMORY.md");
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function ensureDir(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readMemory(filePath: string): Promise<string> {
	if (!existsSync(filePath)) return "";
	return fs.readFile(filePath, "utf8");
}

async function writeMemory(filePath: string, content: string): Promise<void> {
	await ensureDir(filePath);
	await fs.writeFile(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Bullet-point parsing
// The files are free-form markdown, but we deduplicate/clean bullet entries.
// A "bullet" is any line starting with "- " (after optional indentation).
// ---------------------------------------------------------------------------

function parseBullets(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => /^\s*-\s+/.test(line))
		.map((line) => line.trim());
}

function normalizeBullet(bullet: string): string {
	return bullet.replace(/^\s*-\s+/, "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Self-cleaning: remove duplicate bullet entries within the same file.
// Non-bullet lines (headings, blank lines, prose) are kept as-is.
// ---------------------------------------------------------------------------

function deduplicate(content: string): { cleaned: string; removed: number } {
	const seen = new Set<string>();
	let removed = 0;
	const outLines: string[] = [];

	for (const line of content.split("\n")) {
		if (/^\s*-\s+/.test(line)) {
			const key = normalizeBullet(line);
			if (seen.has(key)) {
				removed++;
				continue;
			}
			seen.add(key);
		}
		outLines.push(line);
	}

	// Collapse runs of more than two blank lines produced by removals.
	const collapsed: string[] = [];
	let blankRun = 0;
	for (const line of outLines) {
		if (line.trim() === "") {
			blankRun++;
			if (blankRun <= 2) collapsed.push(line);
		} else {
			blankRun = 0;
			collapsed.push(line);
		}
	}

	return { cleaned: collapsed.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Append a single bullet to a memory file.
// The bullet is added under the relevant section heading if present,
// otherwise appended at the end.
// ---------------------------------------------------------------------------

async function appendFact(filePath: string, fact: string): Promise<void> {
	await ensureDir(filePath);
	let content = await readMemory(filePath);
	if (!content.endsWith("\n") && content.length > 0) content += "\n";
	content += `- ${fact}\n`;
	await writeMemory(filePath, content);
}

// ---------------------------------------------------------------------------
// Self-clean: deduplicate a memory file in-place.
// ---------------------------------------------------------------------------

async function selfClean(filePath: string): Promise<number> {
	if (!existsSync(filePath)) return 0;
	const content = await readMemory(filePath);
	const { cleaned, removed } = deduplicate(content);
	if (removed > 0) await writeMemory(filePath, cleaned);
	return removed;
}

// ---------------------------------------------------------------------------
// Build the system-prompt injection block.
// ---------------------------------------------------------------------------

function buildMemoryBlock(globalContent: string, projectContent: string): string {
	const parts: string[] = [];

	if (globalContent.trim()) {
		parts.push("## Global memory\n\n" + globalContent.trim());
	}

	if (projectContent.trim()) {
		parts.push("## Project memory\n\n" + projectContent.trim());
	}

	if (parts.length === 0) return "";

	return [
		"<memory>",
		"The following facts were remembered from previous sessions. Treat them as standing context.",
		"",
		parts.join("\n\n"),
		"</memory>",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Interactive memory viewer (for /memory command)
// ---------------------------------------------------------------------------

async function showMemoryViewer(
	pi: ExtensionAPI,
	cwd: string,
	ctx: { ui: ExtensionContext["ui"]; hasUI: boolean },
): Promise<void> {
	if (!ctx.hasUI) return;

	const globalPath = globalMemoryPath();
	const projectPath = projectMemoryPath(cwd);
	const globalContent = await readMemory(globalPath);
	const projectContent = await readMemory(projectPath);

	const sections: string[] = [];
	if (globalContent.trim()) {
		sections.push(`### Global memory\n\n${globalContent.trim()}`);
	} else {
		sections.push("### Global memory\n\n_Empty_");
	}
	sections.push("");
	if (projectContent.trim()) {
		sections.push(`### Project memory\n\n${projectContent.trim()}`);
	} else {
		sections.push("### Project memory\n\n_Empty_");
	}

	const mdText = sections.join("\n");

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Memory")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Global: ${globalPath}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Project: ${projectPath}`), 1, 0));
		container.addChild(new Markdown(mdText, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Interactive forget flow (for /memory-forget command)
// ---------------------------------------------------------------------------

async function runForgetFlow(
	cwd: string,
	ctx: { ui: ExtensionContext["ui"]; hasUI: boolean },
): Promise<void> {
	if (!ctx.hasUI) return;

	const scopeChoice = await ctx.ui.select("Which memory file?", [
		"Global (~/.pi/agent/MEMORY.md)",
		"Project (.pi/MEMORY.md)",
	]);
	if (!scopeChoice) return;

	const filePath = scopeChoice.startsWith("Global") ? globalMemoryPath() : projectMemoryPath(cwd);
	const content = await readMemory(filePath);
	const bullets = parseBullets(content);

	if (bullets.length === 0) {
		ctx.ui.notify("No bullet entries found in that file.", "info");
		return;
	}

	const chosen = await ctx.ui.select("Which entry to remove?", bullets);
	if (!chosen) return;

	const confirmed = await ctx.ui.confirm(
		"Remove entry?",
		`Delete: ${chosen}`,
	);
	if (!confirmed) return;

	const keyToRemove = normalizeBullet(chosen);
	const newLines = content.split("\n").filter((line) => {
		if (/^\s*-\s+/.test(line)) {
			return normalizeBullet(line) !== keyToRemove;
		}
		return true;
	});

	await writeMemory(filePath, newLines.join("\n"));
	ctx.ui.notify("Entry removed.", "success");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function memoryExtension(pi: ExtensionAPI) {
	// Self-clean and inject memory on every agent start.
	pi.on("before_agent_start", async (event, ctx) => {
		const globalPath = globalMemoryPath();
		const projectPath = projectMemoryPath(ctx.cwd);

		// Self-cleaning: remove duplicate bullets silently.
		const [globalRemoved, projectRemoved] = await Promise.all([
			selfClean(globalPath),
			selfClean(projectPath),
		]);

		if (globalRemoved > 0 || projectRemoved > 0) {
			const parts: string[] = [];
			if (globalRemoved > 0) parts.push(`${globalRemoved} from global`);
			if (projectRemoved > 0) parts.push(`${projectRemoved} from project`);
			ctx.ui.notify(`Memory: removed ${parts.join(", ")} duplicate entries.`, "info");
		}

		// Read both files (after cleaning).
		const [globalContent, projectContent] = await Promise.all([
			readMemory(globalPath),
			readMemory(projectPath),
		]);

		const block = buildMemoryBlock(globalContent, projectContent);
		if (!block) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + block,
		};
	});

	// Tool for the agent to persist a new fact.
	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a fact, preference, or decision to memory so it is available in future sessions. " +
			"Use scope 'global' for preferences and facts that apply across all projects " +
			"(writing style, tooling choices, personal preferences). " +
			"Use scope 'project' for facts specific to this codebase " +
			"(architecture notes, recurring patterns, key decisions). " +
			"Keep entries concise: one clear fact per call. " +
			"Do NOT call this for transient information that is only relevant to the current task.",
		parameters: Type.Object({
			fact: Type.String({
				description: "The fact to remember. One sentence, imperative or declarative.",
			}),
			scope: StringEnum(["global", "project"] as const, {
				description:
					"'global' saves to ~/.pi/agent/MEMORY.md (cross-project). " +
					"'project' saves to .pi/MEMORY.md (this codebase only).",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath =
				params.scope === "global" ? globalMemoryPath() : projectMemoryPath(ctx.cwd);

			// Ask the user for confirmation before writing.
			if (ctx.hasUI) {
				const label = params.scope === "global" ? "global memory" : "project memory";
				const ok = await ctx.ui.confirm(
					`Remember in ${label}?`,
					params.fact,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "User declined — fact not saved." }],
						details: { saved: false, scope: params.scope, fact: params.fact },
					};
				}
			}

			await appendFact(filePath, params.fact);

			return {
				content: [
					{
						type: "text",
						text: `Remembered (${params.scope}): ${params.fact}`,
					},
				],
				details: { saved: true, scope: params.scope, fact: params.fact, path: filePath },
			};
		},
	});

	// /memory — view both memory files.
	pi.registerCommand("memory", {
		description: "Show global and project memory",
		handler: async (_args, ctx) => {
			await showMemoryViewer(pi, ctx.cwd, ctx);
		},
	});

	// /memory-forget — interactively remove an entry.
	pi.registerCommand("memory-forget", {
		description: "Remove an entry from global or project memory",
		handler: async (_args, ctx) => {
			await runForgetFlow(ctx.cwd, ctx);
		},
	});
}
