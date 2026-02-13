/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses notify-send on Linux (works with GNOME, KDE, etc.) and falls back to
 * OSC 777 for supported terminals (Ghostty, iTerm2, WezTerm, rxvt-unicode).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";

/**
 * Send a desktop notification via notify-send (Linux) or OSC 777 fallback.
 */
const notify = (title: string, body: string): void => {
	if (process.platform === "linux") {
		execFile("notify-send", ["--app-name=pi", title, body], (err) => {
			// Silently ignore errors (e.g. notify-send not installed)
			if (err) {
				// Fall back to OSC 777
				process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
			}
		});
	} else {
		// macOS/other: use OSC 777
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null, cwd?: string): { title: string; body: string } => {
	const dir = cwd ? cwd.replace(/^\/home\/[^/]+/, "~") : "";
	const titlePrefix = dir ? `π ${dir}` : "π";

	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: titlePrefix, body: "Ready for input" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: titlePrefix, body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText, ctx.cwd);
		notify(title, body);
	});
}
