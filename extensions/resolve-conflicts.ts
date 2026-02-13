/**
 * Conflict Resolution Extension
 *
 * Registers a `resolve_conflict` tool the agent uses to present merge/cherry-pick/rebase
 * conflict hunks interactively. The user picks: ours, theirs, agent suggestion, or types
 * a custom resolution.
 *
 * Pairs with the `resolve-conflicts` skill, which handles the overall workflow and calls
 * this tool for each ambiguous conflict.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ConflictDetails {
	file: string;
	location: string;
	context: string;
	ours: string;
	theirs: string;
	suggestion?: string;
	choice: "ours" | "theirs" | "suggestion" | "custom" | "cancelled";
	resolution: string | null;
}

const ConflictParams = Type.Object({
	file: Type.String({ description: "Path to the conflicted file" }),
	location: Type.String({ description: "Line range or function name where the conflict occurs" }),
	context: Type.String({ description: "Brief explanation of what each side was trying to do" }),
	ours: Type.String({ description: "Our side of the conflict (current branch)" }),
	theirs: Type.String({ description: "Their side of the conflict (incoming)" }),
	suggestion: Type.Optional(
		Type.String({ description: "Your suggested resolution if you have one. Omit if unsure." }),
	),
});

type Choice = "ours" | "theirs" | "suggestion" | "custom";

function renderCodeBlock(code: string, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const maxWidth = width - 4; // 4 for "  │ " prefix
	for (const raw of code.split("\n")) {
		const wrapped = wrapTextWithAnsi(raw, maxWidth);
		for (const wl of wrapped) {
			lines.push(truncateToWidth(`  ${theme.fg("borderMuted", "│")} ${wl}`, width));
		}
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "resolve_conflict",
		label: "Resolve Conflict",
		description:
			"Present a merge conflict hunk to the user for interactive resolution. " +
			"Use this for ambiguous conflicts where you are not confident in the correct resolution. " +
			"The user can pick ours, theirs, your suggestion, or type a custom resolution.",
		parameters: ConflictParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `Conflict in ${params.file} at ${params.location} requires interactive resolution, but no UI is available. Please resolve manually.`,
						},
					],
					details: {
						...params,
						choice: "cancelled",
						resolution: null,
					} as ConflictDetails,
				};
			}

			const hasSuggestion = Boolean(params.suggestion);

			const result = await ctx.ui.custom<{ choice: Choice; text: string } | null>(
				(tui, theme, _kb, done) => {
					let selected: Choice = hasSuggestion ? "suggestion" : "ours";
					let editMode = false;
					let cachedLines: string[] | undefined;

					const choices: { key: Choice; label: string; shortcut: string }[] = [
						...(hasSuggestion
							? [{ key: "suggestion" as Choice, label: "Accept suggestion", shortcut: "a" }]
							: []),
						{ key: "ours", label: "Keep ours", shortcut: "o" },
						{ key: "theirs", label: "Take theirs", shortcut: "t" },
						{ key: "custom", label: "Type custom resolution", shortcut: "c" },
					];

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ choice: "custom", text: trimmed });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						// Shortcut keys
						if (hasSuggestion && data === "a") {
							done({ choice: "suggestion", text: params.suggestion! });
							return;
						}
						if (data === "o") {
							done({ choice: "ours", text: params.ours });
							return;
						}
						if (data === "t") {
							done({ choice: "theirs", text: params.theirs });
							return;
						}
						if (data === "c") {
							selected = "custom";
							editMode = true;
							refresh();
							return;
						}

						// Arrow navigation
						if (matchesKey(data, Key.up)) {
							const idx = choices.findIndex((c) => c.key === selected);
							if (idx > 0) {
								selected = choices[idx - 1].key;
								refresh();
							}
							return;
						}
						if (matchesKey(data, Key.down)) {
							const idx = choices.findIndex((c) => c.key === selected);
							if (idx < choices.length - 1) {
								selected = choices[idx + 1].key;
								refresh();
							}
							return;
						}

						if (matchesKey(data, Key.enter)) {
							if (selected === "custom") {
								editMode = true;
								refresh();
								return;
							}
							const text =
								selected === "ours"
									? params.ours
									: selected === "theirs"
										? params.theirs
										: params.suggestion!;
							done({ choice: selected, text });
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));
						const hr = () => add(theme.fg("accent", "─".repeat(width)));

						hr();
						add(
							` ${theme.fg("accent", theme.bold("Conflict"))} ${theme.fg("muted", "in")} ${theme.fg("text", params.file)} ${theme.fg("muted", "at")} ${theme.fg("text", params.location)}`,
						);
						lines.push("");
						add(` ${theme.fg("muted", params.context)}`);
						lines.push("");

						// Ours
						add(` ${theme.fg("toolDiffRemoved", theme.bold("Ours (current branch):"))}`);
						lines.push(...renderCodeBlock(params.ours, width, theme));
						lines.push("");

						// Theirs
						add(` ${theme.fg("toolDiffAdded", theme.bold("Theirs (incoming):"))}`);
						lines.push(...renderCodeBlock(params.theirs, width, theme));

						// Suggestion
						if (hasSuggestion) {
							lines.push("");
							add(` ${theme.fg("warning", theme.bold("Suggestion:"))}`);
							lines.push(...renderCodeBlock(params.suggestion!, width, theme));
						}

						lines.push("");
						hr();
						lines.push("");

						// Choices
						for (const c of choices) {
							const isSelected = c.key === selected;
							const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
							const shortcut = theme.fg("accent", `[${c.shortcut}]`);
							const label = isSelected ? theme.fg("accent", c.label) : theme.fg("text", c.label);
							add(`${prefix}${shortcut} ${label}`);
						}

						if (editMode) {
							lines.push("");
							add(` ${theme.fg("muted", "Your resolution:")}`);
							for (const line of editor.render(width - 2)) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter to submit • Esc to go back"));
						} else {
							add(
								theme.fg(
									"dim",
									` ↑↓ navigate • Enter select • ${hasSuggestion ? "a" : ""}o/t/c shortcut • Esc skip`,
								),
							);
						}
						hr();

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			if (!result) {
				return {
					content: [
						{
							type: "text",
							text: `User skipped conflict in ${params.file} at ${params.location}. Leave it unresolved for now.`,
						},
					],
					details: {
						...params,
						choice: "cancelled",
						resolution: null,
					} as ConflictDetails,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `User chose "${result.choice}" for ${params.file} at ${params.location}. Apply this resolution:\n\n${result.text}`,
					},
				],
				details: {
					...params,
					choice: result.choice,
					resolution: result.text,
				} as ConflictDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("resolve_conflict "));
			text += theme.fg("text", args.file);
			text += theme.fg("muted", ` at ${args.location}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ConflictDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.choice === "cancelled") {
				return new Text(
					theme.fg("warning", "⊘ Skipped ") +
						theme.fg("muted", `${details.file} at ${details.location}`),
					0,
					0,
				);
			}

			const labels: Record<string, string> = {
				ours: "kept ours",
				theirs: "took theirs",
				suggestion: "accepted suggestion",
				custom: "custom resolution",
			};

			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("accent", labels[details.choice] ?? details.choice) +
					theme.fg("muted", ` for ${details.file} at ${details.location}`),
				0,
				0,
			);
		},
	});
}
