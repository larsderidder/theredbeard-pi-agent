/**
 * Python Lint Extension
 *
 * Provides two tools for Python code quality:
 *
 * - ruff_check: Fast linter. Catches unused imports, undefined names, style issues,
 *   common bugs. Use after writing or editing Python files.
 *
 * - mypy_check: Type checker. Catches type mismatches, wrong argument types, None-access
 *   bugs. Use on typed codebases or when type errors are suspected.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function writeTempFile(prefix: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-${prefix}-`));
	const file = join(dir, "output.txt");
	writeFileSync(file, content);
	return file;
}

function resolvePath(p: string, cwd: string): string {
	// Strip leading @ that some models accidentally emit for path args
	const cleaned = p.startsWith("@") ? p.slice(1) : p;
	return resolve(cwd, cleaned);
}

// ---------------------------------------------------------------------------
// ruff_check
// ---------------------------------------------------------------------------

interface RuffIssue {
	filename: string;
	row: number;
	col: number;
	code: string;
	message: string;
}

interface RuffDetails {
	path: string;
	issueCount: number;
	truncated: boolean;
	fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// mypy_check
// ---------------------------------------------------------------------------

interface MypyDetails {
	path: string;
	errorCount: number;
	noteCount: number;
	truncated: boolean;
	fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

	// --- ruff_check ---

	pi.registerTool({
		name: "ruff_check",
		label: "Ruff",
		description:
			"Run ruff on a Python file or directory. Catches unused imports, undefined names, " +
			"style violations, common bugs, and more. Use after writing or editing Python code. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"full output is saved to a temp file when truncated.",
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory to check (absolute or relative to cwd)",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = resolvePath(params.path, ctx.cwd);

			let raw: string;
			try {
				raw = execSync(`ruff check --output-format=json "${target}"`, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 50 * 1024 * 1024,
				});
			} catch (err: any) {
				// ruff exits with code 1 when it finds issues; stdout still has JSON
				raw = err.stdout ?? "";
				if (!raw && err.stderr) {
					throw new Error(`ruff failed: ${err.stderr}`);
				}
			}

			let issues: RuffIssue[] = [];
			try {
				const parsed = JSON.parse(raw || "[]");
				issues = parsed.map((d: any) => ({
					filename: d.filename,
					row: d.location?.row ?? 0,
					col: d.location?.column ?? 0,
					code: d.code ?? "?",
					message: d.message ?? "",
				}));
			} catch {
				throw new Error(`ruff returned unexpected output: ${raw.slice(0, 200)}`);
			}

			if (issues.length === 0) {
				return {
					content: [{ type: "text", text: "No issues found." }],
					details: { path: target, issueCount: 0, truncated: false } as RuffDetails,
				};
			}

			const lines = issues.map(
				(i) => `${i.filename}:${i.row}:${i.col}: ${i.code} ${i.message}`
			);
			const fullText = lines.join("\n");

			const trunc = truncateHead(fullText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: RuffDetails = {
				path: target,
				issueCount: issues.length,
				truncated: trunc.truncated,
			};

			let resultText = trunc.content;

			if (trunc.truncated) {
				details.fullOutputPath = writeTempFile("ruff", fullText);
				resultText +=
					`\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines. ` +
					`Full output: ${details.fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("ruff ")) + theme.fg("muted", args.path),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);

			const d = result.details as RuffDetails | undefined;
			if (!d || d.issueCount === 0) {
				return new Text(theme.fg("success", "✓ No issues"), 0, 0);
			}

			let text = theme.fg("error", `✗ ${d.issueCount} issue${d.issueCount === 1 ? "" : "s"}`);
			if (d.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});

	// --- mypy_check ---

	pi.registerTool({
		name: "mypy_check",
		label: "mypy",
		description:
			"Run mypy on a Python file or directory. Catches type mismatches, wrong argument types, " +
			"missing return types, and None-access bugs. Most useful on codebases that use type " +
			"annotations. Use when type correctness is in question or after adding/changing typed code. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"full output is saved to a temp file when truncated.",
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory to check (absolute or relative to cwd)",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = resolvePath(params.path, ctx.cwd);

			let raw: string;
			try {
				raw = execSync(`uvx mypy "${target}"`, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 50 * 1024 * 1024,
				});
			} catch (err: any) {
				// mypy exits with code 1 when it finds errors; stdout has the report
				raw = err.stdout ?? "";
				if (!raw && err.stderr) {
					throw new Error(`mypy failed: ${err.stderr}`);
				}
			}

			// Parse summary line: "Found N errors in M files (checked K source files)"
			// or "Success: no issues found in K source files"
			const errorMatch = raw.match(/Found (\d+) error/);
			const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
			const noteCount = (raw.match(/^.*: note:/gm) ?? []).length;

			const trunc = truncateHead(raw, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: MypyDetails = {
				path: target,
				errorCount,
				noteCount,
				truncated: trunc.truncated,
			};

			let resultText = trunc.content;

			if (trunc.truncated) {
				details.fullOutputPath = writeTempFile("mypy", raw);
				resultText +=
					`\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines. ` +
					`Full output: ${details.fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("mypy ")) + theme.fg("muted", args.path),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);

			const d = result.details as MypyDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "No output"), 0, 0);

			if (d.errorCount === 0) {
				let text = theme.fg("success", "✓ No errors");
				if (d.noteCount > 0) text += theme.fg("dim", ` (${d.noteCount} notes)`);
				return new Text(text, 0, 0);
			}

			let text = theme.fg("error", `✗ ${d.errorCount} error${d.errorCount === 1 ? "" : "s"}`);
			if (d.noteCount > 0) text += theme.fg("dim", ` + ${d.noteCount} notes`);
			if (d.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});
}
