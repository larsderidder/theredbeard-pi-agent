/**
 * Numbered items walker - navigate through numbered items in assistant responses
 *
 * When the LLM responds with numbered lists (feedback, review points, suggestions),
 * this extension lets you walk through each item one by one and respond individually.
 *
 * Handles multiple sections with their own numbering (e.g. "Pattern: anchor-turn.md"
 * followed by items 1-3, then "Guide: agentic-context-efficiency.md" with items 1-5).
 *
 * Usage:
 * - /items - extract and walk through numbered items from last assistant message
 * - Ctrl+; - same as /items
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

interface ExtractedItem {
	number: number;
	section: string;
	text: string;
}

/**
 * Extract numbered items from text, grouped by section.
 *
 * Looks for patterns like:
 *   1. Some text that may span
 *      multiple lines including sub-bullets
 *   2. Another item
 *
 * Sections are detected by horizontal rules (───) or headings followed by content.
 * Items with the same number in different sections are kept separate.
 *
 * An item continues until the next numbered item, section boundary, or two
 * consecutive blank lines. Single blank lines within an item are preserved
 * (common for sub-bullets and continuation paragraphs).
 */
function extractNumberedItems(text: string): ExtractedItem[] {
	const lines = text.split("\n");
	const items: ExtractedItem[] = [];

	let currentSection = "";
	let currentItemNumber: number | null = null;
	let currentItemLines: string[] = [];
	let consecutiveBlanks = 0;

	function flushItem() {
		if (currentItemNumber !== null && currentItemLines.length > 0) {
			items.push({
				number: currentItemNumber,
				section: currentSection,
				text: currentItemLines.join("\n").trim(),
			});
		}
		currentItemNumber = null;
		currentItemLines = [];
		consecutiveBlanks = 0;
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Detect markdown headings as section boundaries (## Section Name)
		const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
		if (headingMatch) {
			flushItem();
			currentSection = headingMatch[1];
			continue;
		}

		// Detect section boundaries: horizontal rules (box-drawing chars, dashes, equals, or markdown ---)
		if (/^[─━\-=]{3,}$/.test(trimmed)) {
			flushItem();

			// Look ahead for a section title (next non-empty, non-rule line)
			for (let j = i + 1; j < lines.length; j++) {
				const nextTrimmed = lines[j].trim();
				if (!nextTrimmed) continue;
				if (/^[─━\-=]{3,}$/.test(nextTrimmed)) break;
				// Could be a heading or plain text
				const nextHeading = nextTrimmed.match(/^#{1,3}\s+(.+)/);
				currentSection = nextHeading ? nextHeading[1] : nextTrimmed;
				break;
			}
			continue;
		}

		// Detect numbered items. Handles several formats:
		//   1. Plain text              (plain)
		//   1) Plain text              (parenthesis)
		//   **1. Bold text** rest      (bold-wrapped number, common from LLMs)
		//   **1.** Plain text          (bold number only)
		const numberedMatch = line.match(/^(\s*)(?:\*\*)?(\d+)[.)]\*?\*?\s+(.+)/);
		if (numberedMatch) {
			flushItem();
			currentItemNumber = parseInt(numberedMatch[2], 10);
			// Strip bold markers: **text** -> text, text** rest -> rest with text prefix
			let itemText = numberedMatch[3];
			// Handle "Bold part** rest of text" -> "Bold part rest of text"
			itemText = itemText.replace(/\*\*/g, "");
			currentItemLines.push(itemText.trim());
			continue;
		}

		// If we're collecting an item, handle continuation
		if (currentItemNumber !== null) {
			if (trimmed.length === 0) {
				consecutiveBlanks++;
				// Two consecutive blank lines end the item
				if (consecutiveBlanks >= 2) {
					flushItem();
				} else {
					currentItemLines.push("");
				}
				continue;
			}

			// Non-empty line resets blank counter
			consecutiveBlanks = 0;
			currentItemLines.push(trimmed);
			continue;
		}
	}

	flushItem();
	return items;
}

/**
 * Interactive component for walking through numbered items
 */
class ItemsWalkerComponent implements Component {
	private items: ExtractedItem[];
	private responses: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(
		items: ExtractedItem[],
		tui: TUI,
		onDone: (result: string | null) => void,
	) {
		this.items = items;
		this.responses = items.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentResponse(): void {
		this.responses[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.items.length) return;
		this.saveCurrentResponse();
		this.currentIndex = index;
		this.editor.setText(this.responses[index] || "");
		this.invalidate();
	}

	private hasAnyResponses(): boolean {
		this.saveCurrentResponse();
		return this.responses.some((r) => (r?.trim() || "").length > 0);
	}

	private submit(): void {
		this.saveCurrentResponse();

		const parts: string[] = [];
		let lastSection = "";

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const response = this.responses[i]?.trim();
			if (!response) continue;

			// Add section header if it changed
			if (item.section && item.section !== lastSection) {
				if (parts.length > 0) parts.push("");
				parts.push(`## ${item.section}`);
				parts.push("");
				lastSection = item.section;
			}

			parts.push(`**${item.number}.** ${truncateItemText(item.text, 80)}`);
			parts.push(response);
			parts.push("");
		}

		if (parts.length === 0) {
			this.onDone(null);
			return;
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				if (this.hasAnyResponses()) {
					this.submit();
				} else {
					this.cancel();
				}
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.items.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Enter moves to next item, or shows confirmation on last
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentResponse();
			if (this.currentIndex < this.items.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;

		const horizontalLine = (count: number) => "─".repeat(count);

		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const item = this.items[this.currentIndex];

		// Title with section info
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));

		let title = `${this.bold(this.cyan("Items"))} ${this.dim(`(${this.currentIndex + 1}/${this.items.length})`)}`;
		if (item.section) {
			title += `  ${this.gray(truncateItemText(item.section, 50))}`;
		}
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress dots
		const progressParts: string[] = [];
		for (let i = 0; i < this.items.length; i++) {
			const responded = (this.responses[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (responded) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current item text
		const itemLabel = `${this.bold(`${item.number}.`)} `;
		const wrappedItem = wrapTextWithAnsi(itemLabel + item.text, contentWidth);
		for (const line of wrappedItem) {
			lines.push(padToWidth(boxLine(line)));
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Editor for response
		const responsePrefix = this.bold("Response: ");
		const editorWidth = contentWidth - 4 - visibleWidth(responsePrefix);
		const editorLines = this.editor.render(Math.max(editorWidth, 20));
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				lines.push(padToWidth(boxLine(responsePrefix + editorLines[i])));
			} else {
				lines.push(padToWidth(boxLine(" ".repeat(visibleWidth(responsePrefix)) + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Footer
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const hasResponses = this.hasAnyResponses();
			const confirmMsg = hasResponses
				? `${this.yellow("Submit responses?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`
				: `${this.yellow("No responses written. Cancel?")} ${this.dim("(Enter/y to cancel, Esc/n to go back)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function truncateItemText(text: string, maxLen: number): string {
	// Take first line only if multi-line
	const firstLine = text.split("\n")[0];
	if (firstLine.length <= maxLen) return firstLine;
	return firstLine.slice(0, maxLen - 3) + "...";
}

export default function (pi: ExtensionAPI) {
	const itemsHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("items requires interactive mode", "error");
			return;
		}

		// Find the last assistant message
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		// Extract numbered items (no LLM call needed)
		const items = extractNumberedItems(lastAssistantText);

		if (items.length === 0) {
			ctx.ui.notify("No numbered items found in the last message", "info");
			return;
		}

		// Show the walker component
		const result = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new ItemsWalkerComponent(items, tui, done);
		});

		if (result === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		pi.sendMessage(
			{
				customType: "items-response",
				content: "Here are my responses to your numbered items:\n\n" + result,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("items", {
		description: "Walk through numbered items in the last assistant message and respond to each",
		handler: (_args, ctx) => itemsHandler(ctx),
	});

	pi.registerShortcut("ctrl+;", {
		description: "Walk through numbered items",
		handler: itemsHandler,
	});
}
