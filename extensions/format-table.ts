/**
 * Format Table Extension
 *
 * /format-table command that formats markdown tables with aligned columns.
 * Auto-detects numeric columns and right-aligns them.
 *
 * Usage:
 *   /format-table <path> [startLine] [endLine]
 *
 * If no line range is given, formats all tables in the file.
 * If startLine is given without endLine, formats the table containing that line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type Alignment = "left" | "right";

/** Check whether a cell value looks numeric (currency, percentage, fraction, number, ~prefixed). */
function isNumeric(value: string): boolean {
	const v = value.trim();
	if (!v) return false;
	// Currency: $1.23, €5, etc.
	if (/^[~]?[$€£¥]\d/.test(v)) return true;
	// Percentage: 90%, ~100%
	if (/^[~]?\d[\d,.]*%$/.test(v)) return true;
	// Fraction: 4/8, 8/8
	if (/^\d+\/\d+$/.test(v)) return true;
	// Plain number with optional comma/dot grouping: 1,234.56, 3.25
	if (/^[~]?\d[\d,.]*$/.test(v)) return true;
	// Number with unit suffix: 33 min, 29k, 41k words
	if (/^[~]?\d[\d,.]*\s*[a-zA-Z]+$/.test(v)) return true;
	// Win/loss records: 14W / 10L, 1W / 23L
	if (/^\d+W\s*\/\s*\d+L$/i.test(v)) return false; // left-align these, they're labels
	return false;
}

/** Detect alignment for each column based on cell content (header excluded). */
function detectAlignments(rows: string[][]): Alignment[] {
	if (rows.length === 0) return [];
	const cols = rows[0].length;
	const alignments: Alignment[] = new Array(cols).fill("left");

	for (let c = 0; c < cols; c++) {
		// Skip header (row 0), check data rows
		let numericCount = 0;
		let nonEmptyCount = 0;
		for (let r = 1; r < rows.length; r++) {
			const cell = (rows[r][c] ?? "").trim();
			if (!cell || cell === "—" || cell === "-") continue;
			nonEmptyCount++;
			if (isNumeric(cell)) numericCount++;
		}
		// If majority of non-empty cells are numeric, right-align
		if (nonEmptyCount > 0 && numericCount / nonEmptyCount >= 0.5) {
			alignments[c] = "right";
		}
	}

	// First column is always left-aligned (model names, labels)
	alignments[0] = "left";

	return alignments;
}

/** Parse a markdown table row into cells (strips leading/trailing pipes). */
function parseRow(line: string): string[] {
	const trimmed = line.trim();
	// Remove leading and trailing pipe
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return inner.split("|").map((c) => c.trim());
}

/** Check if a line is a separator row (|---|---|). */
function isSeparator(line: string): boolean {
	return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line.trim());
}

/** Check if a line is a table row. */
function isTableRow(line: string): boolean {
	return line.trim().startsWith("|") && line.trim().endsWith("|") && line.includes("|");
}

/** Format a single table (array of raw lines). Returns formatted lines. */
function formatTable(lines: string[]): string[] {
	// Separate header, separator, and data rows
	const allRows: string[][] = [];
	let separatorIdx = -1;

	for (let i = 0; i < lines.length; i++) {
		if (isSeparator(lines[i])) {
			separatorIdx = i;
			continue;
		}
		allRows.push(parseRow(lines[i]));
	}

	if (allRows.length === 0) return lines;

	// Normalize column count
	const cols = Math.max(...allRows.map((r) => r.length));
	for (const row of allRows) {
		while (row.length < cols) row.push("");
	}

	// Detect alignments from content
	const alignments = detectAlignments(allRows);

	// Calculate max width per column
	const widths: number[] = new Array(cols).fill(0);
	for (const row of allRows) {
		for (let c = 0; c < cols; c++) {
			widths[c] = Math.max(widths[c], (row[c] ?? "").length);
		}
	}

	// Ensure minimum width of 3 for separator dashes
	for (let c = 0; c < cols; c++) {
		widths[c] = Math.max(widths[c], 3);
	}

	// Build formatted output
	const result: string[] = [];

	for (let r = 0; r < allRows.length; r++) {
		const row = allRows[r];
		const cells = row.map((cell, c) => {
			if (alignments[c] === "right") {
				return cell.padStart(widths[c]);
			}
			return cell.padEnd(widths[c]);
		});
		result.push(`| ${cells.join(" | ")} |`);

		// Insert separator after header (first row)
		if (r === 0) {
			const sep = widths.map((w, c) => {
				if (alignments[c] === "right") {
					return "-".repeat(w - 1) + ":";
				}
				return ":" + "-".repeat(w - 1);
			});
			result.push(`| ${sep.join(" | ")} |`);
		}
	}

	return result;
}

/** Find table boundaries around a given line number. */
function findTableBounds(
	lines: string[],
	lineNum: number,
): { start: number; end: number } | null {
	if (!isTableRow(lines[lineNum]) && !isSeparator(lines[lineNum])) {
		return null;
	}

	let start = lineNum;
	while (start > 0 && (isTableRow(lines[start - 1]) || isSeparator(lines[start - 1]))) {
		start--;
	}

	let end = lineNum;
	while (
		end < lines.length - 1 &&
		(isTableRow(lines[end + 1]) || isSeparator(lines[end + 1]))
	) {
		end++;
	}

	return { start, end };
}

/** Find all tables in a file. Returns array of { start, end } bounds. */
function findAllTables(lines: string[]): Array<{ start: number; end: number }> {
	const tables: Array<{ start: number; end: number }> = [];
	let i = 0;

	while (i < lines.length) {
		if (isTableRow(lines[i]) || isSeparator(lines[i])) {
			const bounds = findTableBounds(lines, i);
			if (bounds) {
				tables.push(bounds);
				i = bounds.end + 1;
				continue;
			}
		}
		i++;
	}

	return tables;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("format-table", {
		description: "Format markdown tables: /format-table <path> [line]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length === 0 || !parts[0]) {
				ctx.reply("Usage: /format-table <path> [line]\n\nFormats all tables in the file, or the table containing the given line number.");
				return;
			}

			const filePath = path.isAbsolute(parts[0])
				? parts[0]
				: path.resolve(ctx.cwd, parts[0]);
			const lineArg = parts[1] ? parseInt(parts[1], 10) : undefined;

			let content: string;
			try {
				content = readFileSync(filePath, "utf-8");
			} catch (e) {
				ctx.reply(`Could not read file: ${filePath}`);
				return;
			}

			const lines = content.split("\n");

			if (lineArg !== undefined) {
				// Format the table containing this line (1-indexed)
				const idx = lineArg - 1;
				if (idx < 0 || idx >= lines.length) {
					ctx.reply(`Line ${lineArg} is out of range (file has ${lines.length} lines).`);
					return;
				}

				const bounds = findTableBounds(lines, idx);
				if (!bounds) {
					ctx.reply(`No markdown table found at line ${lineArg}.`);
					return;
				}

				const tableLines = lines.slice(bounds.start, bounds.end + 1);
				const formatted = formatTable(tableLines);
				lines.splice(bounds.start, bounds.end - bounds.start + 1, ...formatted);
				writeFileSync(filePath, lines.join("\n"), "utf-8");

				ctx.reply(`Formatted table at lines ${bounds.start + 1}-${bounds.end + 1} in ${path.basename(filePath)}.`);
			} else {
				// Format all tables in the file
				const tables = findAllTables(lines);
				if (tables.length === 0) {
					ctx.reply(`No markdown tables found in ${path.basename(filePath)}.`);
					return;
				}

				// Process in reverse order so line numbers stay valid
				for (let t = tables.length - 1; t >= 0; t--) {
					const { start, end } = tables[t];
					const tableLines = lines.slice(start, end + 1);
					const formatted = formatTable(tableLines);
					lines.splice(start, end - start + 1, ...formatted);
				}

				writeFileSync(filePath, lines.join("\n"), "utf-8");
				ctx.reply(`Formatted ${tables.length} table${tables.length > 1 ? "s" : ""} in ${path.basename(filePath)}.`);
			}
		},
	});
}
