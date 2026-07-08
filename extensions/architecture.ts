/**
 * Architecture Extension
 *
 * Maintains a `.pi/architecture/` directory with structured notes about the
 * codebase so the agent can orient faster in future sessions.
 *
 * - `/map` command: scan the repo and update architecture notes
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

const ARCH_DIR = ".pi/architecture";
const INDEX_FILE = "index.md";

// Output cost per million tokens above which we suggest switching models.
// Sonnet is $15/M, Opus is $75/M. Anything above $20/M is probably overkill for map generation.
const EXPENSIVE_OUTPUT_COST = 20;

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

export default function architectureExtension(pi: ExtensionAPI) {
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
