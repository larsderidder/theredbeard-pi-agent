/**
 * Walkthrough Extension
 *
 * /walkthrough [path] - walks through every unstaged change hunk by hunk.
 * For each hunk the agent explains what it does, then waits for you to
 * press N (next), P (previous), or Q (quit).
 *
 * Usage:
 *   /walkthrough          - all unstaged changes
 *   /walkthrough src/     - limit to a path
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

interface Hunk {
	header: string;
	lines: string[];
}

interface FileDiff {
	path: string;
	hunks: Hunk[];
}

function parseDiff(raw: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let currentHunk: Hunk | null = null;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (currentHunk && current) current.hunks.push(currentHunk);
			if (current) files.push(current);
			const match = line.match(/b\/(.+)$/);
			current = { path: match ? match[1] : line, hunks: [] };
			currentHunk = null;
			continue;
		}

		if (!current) continue;

		if (line.startsWith("@@ ")) {
			if (currentHunk) current.hunks.push(currentHunk);
			currentHunk = { header: line, lines: [] };
			continue;
		}

		if (!currentHunk) continue;

		if (
			line.startsWith("+") ||
			line.startsWith("-") ||
			line.startsWith(" ") ||
			line === "\\ No newline at end of file"
		) {
			currentHunk.lines.push(line);
		}
	}

	if (currentHunk && current) current.hunks.push(currentHunk);
	if (current) files.push(current);

	return files.filter((f) => f.hunks.length > 0);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface Step {
	fileIndex: number;
	hunkIndex: number;
	filePath: string;
	hunk: Hunk;
	fileHunkCount: number;
	totalSteps: number;
	stepIndex: number;
}

function buildSteps(files: FileDiff[]): Step[] {
	const steps: Step[] = [];
	for (let fi = 0; fi < files.length; fi++) {
		const file = files[fi];
		for (let hi = 0; hi < file.hunks.length; hi++) {
			steps.push({
				fileIndex: fi,
				hunkIndex: hi,
				filePath: file.path,
				hunk: file.hunks[hi],
				fileHunkCount: file.hunks.length,
				totalSteps: 0, // filled in below
				stepIndex: steps.length,
			});
		}
	}
	for (const s of steps) s.totalSteps = steps.length;
	return steps;
}

// ---------------------------------------------------------------------------
// Per-hunk prompt shown in the diff viewer
// ---------------------------------------------------------------------------

function hunkDiffText(step: Step): string {
	return [step.hunk.header, ...step.hunk.lines].join("\n");
}

function explainPrompt(step: Step): string {
	return (
		`Hunk ${step.stepIndex + 1} of ${step.totalSteps} — \`${step.filePath}\` ` +
		`(hunk ${step.hunkIndex + 1}/${step.fileHunkCount}):\n\n` +
		`\`\`\`diff\n${hunkDiffText(step)}\n\`\`\`\n\n` +
		`Please explain in 2-5 sentences what this change does and why it matters. ` +
		`Be concrete about intent and impact, not just mechanics. ` +
		`After your explanation, wait — the user will press N to move on.`
	);
}

// ---------------------------------------------------------------------------
// Navigation UI
// ---------------------------------------------------------------------------

type NavChoice = "next" | "prev" | "explain" | "quit";

async function askNav(step: Step, ui: any): Promise<NavChoice> {
	const isLast = step.stepIndex === step.totalSteps - 1;

	return new Promise<NavChoice>((resolve) => {
		ui.custom<NavChoice>((tui: any, theme: any, _kb: any, done: (v: NavChoice) => void) => {
			let cachedLines: string[] | undefined;

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const rule = theme.fg("accent", "─".repeat(width));
				const lines: string[] = [];

				lines.push(rule);

				// Hunk header
				const fileLabel = theme.bold(theme.fg("toolTitle", step.filePath));
				const hunkLabel = theme.fg("muted", `  hunk ${step.hunkIndex + 1}/${step.fileHunkCount}`);
				const progress = theme.fg("dim", `  [${step.stepIndex + 1}/${step.totalSteps}]`);
				lines.push(truncateToWidth(` ${fileLabel}${hunkLabel}${progress}`, width));
				lines.push("");

				// Diff content — use all available rows minus fixed chrome lines
				// (rule + header + blank + @@ line + blank + blank + rule + nav + rule = 9)
				const chromeLines = 9;
				const maxDiffLines = Math.max(8, (process.stdout.rows ?? 24) - chromeLines);
				const diffLines = step.hunk.lines.slice(0, maxDiffLines);
				const overflow = step.hunk.lines.length - maxDiffLines;

				for (const dl of diffLines) {
					if (dl.startsWith("+")) {
						lines.push(truncateToWidth(theme.fg("success", dl), width));
					} else if (dl.startsWith("-")) {
						lines.push(truncateToWidth(theme.fg("error", dl), width));
					} else {
						lines.push(truncateToWidth(theme.fg("dim", dl), width));
					}
				}

				if (overflow > 0) {
					lines.push(theme.fg("warning", ` … ${overflow} more lines`));
				}

				lines.push("");
				lines.push(rule);

				// Nav hints
				const prevHint =
					step.stepIndex > 0 ? theme.fg("accent", "← p  prev") : theme.fg("dim", "← p  prev");
				const nextHint = isLast
					? theme.fg("success", "→ n  finish")
					: theme.fg("accent", "→ n  next");
				const explainHint = theme.fg("accent", "e  explain");
				const quitHint = theme.fg("warning", "q  quit");
				lines.push(` ${prevHint}    ${nextHint}    ${explainHint}    ${quitHint}`);
				lines.push(rule);

				cachedLines = lines;
				return lines;
			}

			function handleInput(data: string): void {
				if (data === "q" || data === "Q" || matchesKey(data, "escape")) {
					done("quit");
					return;
				}
				if (matchesKey(data, "right") || data === "n" || data === "N" || matchesKey(data, "return")) {
					done("next");
					return;
				}
				if (matchesKey(data, "left") || data === "p" || data === "P") {
					done("prev");
					return;
				}
				if (data === "e" || data === "E") {
					done("explain");
					return;
				}
			}

			return {
				render,
				invalidate: () => { cachedLines = undefined; },
				handleInput,
			};
		}).then(resolve);
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("walkthrough", {
		description: "Walk through unstaged changes hunk by hunk — the agent explains each one",
		handler: async (args, ctx) => {
			const pathArg = args?.trim() ?? "";
			const gitArgs = pathArg ? ["diff", "--", pathArg] : ["diff"];

			const result = await pi.exec("git", gitArgs);

			if (result.code !== 0) {
				ctx.ui.notify(`git diff failed: ${result.stderr}`, "error");
				return;
			}

			const raw = result.stdout.trim();
			if (!raw) {
				ctx.ui.notify("No unstaged changes found.", "info");
				return;
			}

			const files = parseDiff(raw);
			if (files.length === 0) {
				ctx.ui.notify("Could not parse any hunks from the diff.", "warning");
				return;
			}

			const steps = buildSteps(files);
			const hunkWord = steps.length === 1 ? "hunk" : "hunks";
			const fileWord = files.length === 1 ? "file" : "files";
			ctx.ui.notify(
				`${files.length} changed ${fileWord}, ${steps.length} ${hunkWord}. Starting walkthrough.`,
				"info",
			);

			let i = 0;

			while (i >= 0 && i < steps.length) {
				const step = steps[i];
				const choice = await askNav(step, ctx.ui);

				if (choice === "quit") break;
				if (choice === "next") { i++; continue; }
				if (choice === "prev") { if (i > 0) i--; continue; }

				if (choice === "explain") {
					pi.sendUserMessage(explainPrompt(step));
					await ctx.waitForIdle();
				}
			}

			if (i >= steps.length) {
				ctx.ui.notify("Walkthrough complete.", "success");
			}
		},
	});
}
