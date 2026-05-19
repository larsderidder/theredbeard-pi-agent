/**
 * TypeScript Lint Extension
 *
 * Provides two tools for TypeScript code quality:
 *
 * - tsc_check: Type checking via the project's own tsc. Requires a tsconfig.json.
 *   Use after writing or editing TypeScript code to catch type errors.
 *
 * - eslint_check: Linting via the project's own ESLint. Requires ESLint to be
 *   installed in the project and a config file present. Fails gracefully if not set up.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/**
 * Walk up from startDir looking for a file by name.
 * Returns the directory containing the file, or null if not found.
 */
function findUpDir(startDir: string, filename: string): string | null {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, filename))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ---------------------------------------------------------------------------
// Details interfaces
// ---------------------------------------------------------------------------

interface TscDetails {
	path: string;
	projectRoot: string;
	errorCount: number;
	truncated: boolean;
	fullOutputPath?: string;
}

interface EslintDetails {
	path: string;
	projectRoot: string;
	errorCount: number;
	warningCount: number;
	truncated: boolean;
	fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

	// --- tsc_check ---

	pi.registerTool({
		name: "tsc_check",
		label: "tsc",
		description:
			"Run the TypeScript compiler (tsc --noEmit) on a project to check for type errors. " +
			"Requires a tsconfig.json in or above the target path. Uses the project's own tsc " +
			"via npx so it always matches the project's TypeScript version. " +
			"Use after writing or editing TypeScript code. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"full output is saved to a temp file when truncated.",
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory to check (absolute or relative to cwd). " +
					"tsc will use the nearest tsconfig.json found at or above this path.",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = resolvePath(params.path, ctx.cwd);

			// Find the nearest tsconfig.json
			const startDir = existsSync(target) && target.endsWith(".ts")
				? dirname(target)
				: target;
			const projectRoot = findUpDir(startDir, "tsconfig.json");

			if (!projectRoot) {
				throw new Error(
					`No tsconfig.json found at or above "${target}". ` +
					"tsc_check requires a TypeScript project with a tsconfig.json."
				);
			}

			let raw: string;
			try {
				raw = execSync("npx --no-install tsc --noEmit", {
					cwd: projectRoot,
					encoding: "utf-8",
					maxBuffer: 50 * 1024 * 1024,
				});
			} catch (err: any) {
				// tsc exits with code 1 when there are type errors; stdout has the report
				raw = err.stdout ?? "";
				const stderr = err.stderr ?? "";

				// If stdout is empty and stderr has content, it's a real failure
				if (!raw.trim() && stderr.includes("not found")) {
					throw new Error(
						"tsc not found. Make sure typescript is installed in the project: npm install --save-dev typescript"
					);
				}
				if (!raw.trim() && stderr.trim()) {
					throw new Error(`tsc failed: ${stderr.slice(0, 500)}`);
				}
			}

			// Count "error TS" occurrences for the summary
			const errorCount = (raw.match(/error TS\d+/g) ?? []).length;

			const trunc = truncateHead(raw, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: TscDetails = {
				path: target,
				projectRoot,
				errorCount,
				truncated: trunc.truncated,
			};

			if (errorCount === 0 && !raw.trim()) {
				return {
					content: [{ type: "text", text: "No type errors found." }],
					details,
				};
			}

			let resultText = trunc.content || "No type errors found.";

			if (trunc.truncated) {
				details.fullOutputPath = writeTempFile("tsc", raw);
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
				theme.fg("toolTitle", theme.bold("tsc ")) +
				theme.fg("dim", "--noEmit ") +
				theme.fg("muted", args.path),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Type checking..."), 0, 0);

			const d = result.details as TscDetails | undefined;
			if (!d || d.errorCount === 0) {
				return new Text(theme.fg("success", "✓ No type errors"), 0, 0);
			}

			let text = theme.fg("error", `✗ ${d.errorCount} type error${d.errorCount === 1 ? "" : "s"}`);
			if (d.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});

	// --- eslint_check ---

	pi.registerTool({
		name: "eslint_check",
		label: "ESLint",
		description:
			"Run ESLint on a TypeScript or JavaScript file or directory. " +
			"Catches unused variables, style violations, potential bugs, and rule violations " +
			"defined in the project's own ESLint config. " +
			"Uses the project's own ESLint via npx so it respects project-local config and plugins. " +
			"Fails gracefully if ESLint is not installed or no config file is found. " +
			"Use after writing or editing TypeScript/JavaScript code when the project has ESLint set up. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ` +
			"full output is saved to a temp file when truncated.",
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory to lint (absolute or relative to cwd).",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = resolvePath(params.path, ctx.cwd);

			// Check for ESLint config. Flat config (eslint.config.*) takes priority,
			// then legacy formats. Walk up from the target to find one.
			const startDir = existsSync(target) && !target.match(/\.(ts|js|tsx|jsx|mjs|cjs)$/)
				? target
				: dirname(target);

			const flatConfigs = [
				"eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
			];
			const legacyConfigs = [
				".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc.json", ".eslintrc",
			];

			const flatRoot = flatConfigs.reduce<string | null>(
				(found, name) => found ?? findUpDir(startDir, name),
				null
			);
			const legacyRoot = legacyConfigs.reduce<string | null>(
				(found, name) => found ?? findUpDir(startDir, name),
				null
			);

			const projectRoot = flatRoot ?? legacyRoot;

			if (!projectRoot) {
				throw new Error(
					`No ESLint config found at or above "${target}". ` +
					"eslint_check requires an ESLint config (eslint.config.js, .eslintrc.*, etc.)."
				);
			}

			// Check ESLint is actually installed in the project
			const eslintBin = join(projectRoot, "node_modules", ".bin", "eslint");
			if (!existsSync(eslintBin)) {
				throw new Error(
					`ESLint not found at "${eslintBin}". ` +
					"Install it with: npm install --save-dev eslint"
				);
			}

			let raw: string;
			try {
				raw = execSync(`npx --no-install eslint --format=unix "${target}"`, {
					cwd: projectRoot,
					encoding: "utf-8",
					maxBuffer: 50 * 1024 * 1024,
				});
			} catch (err: any) {
				// ESLint exits with code 1 when there are lint errors; stdout has the report
				raw = err.stdout ?? "";
				const stderr = err.stderr ?? "";

				if (!raw.trim() && stderr.trim()) {
					throw new Error(`ESLint failed: ${stderr.slice(0, 500)}`);
				}
			}

			// Parse unix format summary: "N problems (E errors, W warnings)"
			const summaryMatch = raw.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
			const errorCount = summaryMatch ? parseInt(summaryMatch[2], 10) : 0;
			const warningCount = summaryMatch ? parseInt(summaryMatch[3], 10) : 0;

			const trunc = truncateHead(raw, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: EslintDetails = {
				path: target,
				projectRoot,
				errorCount,
				warningCount,
				truncated: trunc.truncated,
			};

			if (errorCount === 0 && warningCount === 0 && !raw.trim()) {
				return {
					content: [{ type: "text", text: "No issues found." }],
					details,
				};
			}

			let resultText = trunc.content || "No issues found.";

			if (trunc.truncated) {
				details.fullOutputPath = writeTempFile("eslint", raw);
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
				theme.fg("toolTitle", theme.bold("eslint ")) + theme.fg("muted", args.path),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Linting..."), 0, 0);

			const d = result.details as EslintDetails | undefined;
			if (!d || (d.errorCount === 0 && d.warningCount === 0)) {
				return new Text(theme.fg("success", "✓ No issues"), 0, 0);
			}

			let text = "";
			if (d.errorCount > 0) {
				text += theme.fg("error", `✗ ${d.errorCount} error${d.errorCount === 1 ? "" : "s"}`);
			}
			if (d.warningCount > 0) {
				if (text) text += theme.fg("dim", ", ");
				text += theme.fg("warning", `⚠ ${d.warningCount} warning${d.warningCount === 1 ? "" : "s"}`);
			}
			if (d.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});
}
