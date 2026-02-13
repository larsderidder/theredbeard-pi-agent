/**
 * Architecture Extension
 *
 * Maintains a `.pi/architecture/` directory with structured notes about the
 * codebase so the agent can orient faster in future sessions.
 *
 * - `/map` command: scan the repo and update architecture notes
 * - Passive tracking: counts exploration tool calls (read, bash with grep/find/ls)
 *   and suggests updating when a threshold is crossed in a single agent run
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

const ARCH_DIR = ".pi/architecture";
const INDEX_FILE = "index.md";
const EXPLORE_THRESHOLD = 15;

// Output cost per million tokens above which we suggest switching models.
// Sonnet is $15/M, Opus is $75/M. Anything above $20/M is probably overkill for map generation.
const EXPENSIVE_OUTPUT_COST = 20;

type ExplorationStats = {
	reads: Set<string>;
	greps: number;
	finds: number;
	lsOps: number;
	directories: Set<string>;
};

type MutationStats = {
	writtenFiles: Set<string>;
	editedFiles: Set<string>;
	mutatedDirectories: Set<string>;
};

function freshStats(): ExplorationStats {
	return {
		reads: new Set(),
		greps: 0,
		finds: 0,
		lsOps: 0,
		directories: new Set(),
	};
}

function freshMutationStats(): MutationStats {
	return {
		writtenFiles: new Set(),
		editedFiles: new Set(),
		mutatedDirectories: new Set(),
	};
}

function explorationCount(stats: ExplorationStats): number {
	return stats.reads.size + stats.greps + stats.finds + stats.lsOps;
}

function mutatedFileCount(stats: MutationStats): number {
	const all = new Set([...stats.writtenFiles, ...stats.editedFiles]);
	return all.size;
}

// Threshold: enough changed files across enough directories to warrant a map refresh.
// Deliberately higher than the exploration threshold since writes are more intentional.
const MUTATION_FILE_THRESHOLD = 8;
const MUTATION_DIR_THRESHOLD = 3;

function getArchDir(cwd: string): string {
	return path.join(cwd, ARCH_DIR);
}

function listArchFiles(cwd: string): string[] {
	const dir = getArchDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

function readArchFile(cwd: string, name: string): string | null {
	const filePath = path.join(getArchDir(cwd), name);
	if (!fs.existsSync(filePath)) return null;
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function buildArchContext(cwd: string): string | null {
	const files = listArchFiles(cwd);
	if (files.length === 0) return null;

	const sections: string[] = [];
	for (const file of files) {
		const content = readArchFile(cwd, file);
		if (!content) continue;
		if (file === INDEX_FILE) {
			sections.unshift(content);
		} else {
			sections.push(content);
		}
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n---\n\n");
}

function extractReadDir(filePath: string, cwd: string): string | null {
	if (!filePath) return null;
	const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	const rel = path.relative(cwd, abs);
	if (rel.startsWith("..")) return null;
	const dir = path.dirname(rel);
	return dir === "." ? "" : dir;
}

function isBashExploration(command: string): { greps: number; finds: number; lsOps: number } {
	let greps = 0;
	let finds = 0;
	let lsOps = 0;

	// Simple heuristic: count exploration-like commands in the string.
	// This catches grep, rg, ag, git grep, etc.
	if (/\b(grep|rg|ag|git\s+grep)\b/i.test(command)) greps++;
	if (/\bfind\b/.test(command)) finds++;
	if (/\b(ls|tree|fd)\b/.test(command)) lsOps++;

	return { greps, finds, lsOps };
}

export default function architectureExtension(pi: ExtensionAPI) {
	let stats = freshStats();
	let mutations = freshMutationStats();
	let alreadySuggested = false;
	let alreadySuggestedMutation = false;

	// Inject architecture context into the system prompt when available
	pi.on("before_agent_start", async (event, ctx) => {
		const archContext = buildArchContext(ctx.cwd);
		if (!archContext) return;

		const injection =
			"\n\n## Project Architecture Notes\n\n" +
			"Codebase map for fast navigation. Lives in `.pi/architecture/` " +
			"(index.md plus topic files). If these are outdated after a structural " +
			"change, update the relevant files directly. User can run `/map` for " +
			"a full refresh.\n\n" +
			archContext;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// Reset stats at the start of each agent run
	pi.on("agent_start", async () => {
		stats = freshStats();
		mutations = freshMutationStats();
		alreadySuggested = false;
		alreadySuggestedMutation = false;
	});

	// Track tool calls to gauge how much exploration is happening
	pi.on("tool_result", (event, ctx) => {
		const toolName = (event as any).toolName as string | undefined;
		const input = (event as any).input as Record<string, unknown> | undefined;
		if ((event as any).isError) return;

		if (toolName === "read" && typeof input?.path === "string") {
			stats.reads.add(input.path);
			const dir = extractReadDir(input.path, ctx.cwd);
			if (dir !== null) stats.directories.add(dir);
		}

		if (toolName === "bash" && typeof input?.command === "string") {
			const hits = isBashExploration(input.command);
			stats.greps += hits.greps;
			stats.finds += hits.finds;
			stats.lsOps += hits.lsOps;
		}

		if (toolName === "ls") {
			stats.lsOps++;
		}

		if (toolName === "grep" || toolName === "find") {
			if (toolName === "grep") stats.greps++;
			if (toolName === "find") stats.finds++;
		}

		// Track mutations (writes and edits), excluding the architecture notes themselves
		if ((toolName === "write" || toolName === "edit") && typeof input?.path === "string") {
			const filePath = input.path;
			const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
			const archDir = getArchDir(ctx.cwd);
			if (!abs.startsWith(archDir + path.sep) && abs !== archDir) {
				if (toolName === "write") mutations.writtenFiles.add(filePath);
				if (toolName === "edit") mutations.editedFiles.add(filePath);
				const dir = extractReadDir(filePath, ctx.cwd);
				if (dir !== null) mutations.mutatedDirectories.add(dir);
			}
		}
	});

	// After the agent finishes, check if we should suggest updating architecture
	pi.on("agent_end", async (_event, ctx) => {
		if (alreadySuggested) return;
		if (!ctx.hasUI) return;

		const count = explorationCount(stats);
		if (count < EXPLORE_THRESHOLD) return;

		// Only suggest if there's enough unique directory spread
		if (stats.directories.size < 3 && stats.reads.size < 8) return;

		alreadySuggested = true;

		const dirCount = stats.directories.size;
		const readCount = stats.reads.size;
		const hint = "Consider running /map to update architecture notes (Sonnet works fine for this).";
		ctx.ui.notify(
			`Explored ${readCount} files across ${dirCount} directories. ${hint}`,
			"info",
		);
	});

	// After the agent finishes, check if a large refactor might have made the notes stale
	pi.on("agent_end", async (_event, ctx) => {
		if (alreadySuggestedMutation) return;
		if (!ctx.hasUI) return;

		// Only suggest if architecture notes actually exist (otherwise /map exploration hint covers it)
		if (listArchFiles(ctx.cwd).length === 0) return;

		const fileCount = mutatedFileCount(mutations);
		const dirCount = mutations.mutatedDirectories.size;
		if (fileCount < MUTATION_FILE_THRESHOLD || dirCount < MUTATION_DIR_THRESHOLD) return;

		alreadySuggestedMutation = true;

		ctx.ui.notify(
			`Modified ${fileCount} files across ${dirCount} directories. Architecture notes may be stale; consider running /map to refresh.`,
			"info",
		);
	});

	// /map command: ask the agent to scan and update architecture notes
	pi.registerCommand("map", {
		description: "Update .pi/architecture/ notes for the codebase",
		handler: async (args, ctx: ExtensionCommandContext) => {
			// Warn if running on an expensive model
			if (ctx.hasUI && ctx.model?.cost) {
				const outputCost = ctx.model.cost.output ?? 0;
				if (outputCost > EXPENSIVE_OUTPUT_COST) {
					const modelName = ctx.model.name || ctx.model.id;
					const ok = await ctx.ui.confirm(
						"Expensive model",
						`You're on ${modelName} ($${outputCost}/M output tokens). ` +
						"Mapping is mostly file reading and markdown writing. " +
						"Sonnet works just as well for this. Continue anyway?",
					);
					if (!ok) {
						ctx.ui.notify("Cancelled. Switch models with /model, then try /map again.", "info");
						return;
					}
				}
			}

			const archDir = getArchDir(ctx.cwd);
			const existing = listArchFiles(ctx.cwd);
			const hasExisting = existing.length > 0;

			let existingContent = "";
			if (hasExisting) {
				const parts: string[] = [];
				for (const file of existing) {
					const content = readArchFile(ctx.cwd, file);
					if (content) {
						parts.push(`--- ${file} ---\n${content}`);
					}
				}
				existingContent = parts.join("\n\n");
			}

			const focus = args?.trim() || "";

			const styleGuide =
				"\n\nStyle rules for architecture notes:\n" +
				"- These are read by an LLM, not humans. Optimize for machine readability.\n" +
				"- Be terse. No prose, no filler, no full sentences where a list entry works.\n" +
				"- No directory trees. Just name key paths and what they contain.\n" +
				"- Focus on: what lives where, how pieces connect, non-obvious conventions.\n" +
				"- Skip anything obvious from file/directory names alone.\n" +
				"- Each topic file should be under 80 lines. If it's longer, you're over-explaining.\n" +
				"- Use `path -> description` format for file/directory references.";

			let prompt: string;
			if (hasExisting && focus) {
				prompt =
					`Update the architecture notes in \`${ARCH_DIR}/\` with a focus on: ${focus}\n\n` +
					`Current notes:\n\n${existingContent}\n\n` +
					"Explore the relevant parts of the codebase, then update or create the " +
					"appropriate files. Keep index.md as a brief overview linking to topic files." +
					styleGuide;
			} else if (hasExisting) {
				prompt =
					`Review and update the architecture notes in \`${ARCH_DIR}/\`.\n\n` +
					`Current notes:\n\n${existingContent}\n\n` +
					"Explore the codebase to check if anything has changed or is missing, " +
					"then update the files accordingly. Keep the same structure unless a " +
					"reorganization is clearly needed." +
					styleGuide;
			} else {
				prompt =
					`Create architecture notes for this codebase in \`${ARCH_DIR}/\`.\n\n` +
					"Start by exploring the project structure, then create:\n" +
					`1. \`${ARCH_DIR}/index.md\` - brief overview, links to topic files\n` +
					"2. One file per major area (e.g., extensions.md, skills.md, build.md)\n\n" +
					(focus ? `Focus especially on: ${focus}\n` : "") +
					"Use relative links between files." +
					styleGuide;
			}

			if (!fs.existsSync(archDir)) {
				fs.mkdirSync(archDir, { recursive: true });
			}

			pi.sendUserMessage(prompt);
		},
	});

	// Shortcut to quickly check what architecture notes exist
	pi.registerCommand("map-status", {
		description: "Show current architecture notes status",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const files = listArchFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("No architecture notes found. Run /map to create them.", "info");
				return;
			}

			const lines: string[] = [`Architecture notes (${files.length} files):`];
			for (const file of files) {
				const content = readArchFile(ctx.cwd, file);
				const lineCount = content ? content.split("\n").length : 0;
				lines.push(`  ${file} (${lineCount} lines)`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
