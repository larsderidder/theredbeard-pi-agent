import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type ClipboardCommand = {
	cmd: string;
	args: string[];
};

function commandExists(cmd: string): boolean {
	const result = process.platform === "win32"
		? spawnSync("where.exe", [cmd], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
		: spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", cmd], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	return result.status === 0;
}

function hasWaylandDisplay(): boolean {
	if (process.env.WAYLAND_DISPLAY) return true;
	if (!process.env.XDG_RUNTIME_DIR) return false;
	return fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR, "wayland-0"));
}

function getClipboardCommand(): ClipboardCommand | undefined {
	if (process.platform === "darwin" && commandExists("pbcopy")) {
		return { cmd: "pbcopy", args: [] };
	}

	if (process.platform === "win32" && commandExists("clip.exe")) {
		return { cmd: "clip.exe", args: [] };
	}

	if (hasWaylandDisplay() && commandExists("wl-copy")) {
		return { cmd: "wl-copy", args: ["--type", "text/plain"] };
	}

	if (process.env.DISPLAY && commandExists("xclip")) {
		return { cmd: "xclip", args: ["-selection", "clipboard"] };
	}

	if (process.env.DISPLAY && commandExists("xsel")) {
		return { cmd: "xsel", args: ["--clipboard", "--input"] };
	}

	return undefined;
}

function writeOsc52(text: string) {
	const payload = Buffer.from(text, "utf-8").toString("base64");
	let sequence = `\x1b]52;c;${payload}\x07`;

	if (process.env.TMUX) {
		sequence = `\x1bPtmux;\x1b${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
	} else if (process.env.TERM?.startsWith("screen")) {
		sequence = `\x1bP${sequence}\x1b\\`;
	}

	fs.writeFileSync("/dev/tty", sequence);
}

function writeClipboard(text: string) {
	const command = getClipboardCommand();
	if (!command) {
		writeOsc52(text);
		return "OSC 52 terminal escape";
	}

	const result = spawnSync(command.cmd, command.args, {
		input: text,
		encoding: "utf-8",
		timeout: 5000,
		maxBuffer: 1024 * 1024,
	});

	if (result.error) throw result.error;
	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		throw new Error(stderr || `${command.cmd} exited with status ${result.status ?? "unknown"}`);
	}

	return command.cmd;
}

type CodeBlock = {
	index: number;
	language: string;
	code: string;
	preview: string;
};

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const maybeText = block as { type?: unknown; text?: unknown };
			return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
		})
		.join("");
}

function getLastAssistantText(entries: unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;

		const text = getTextContent(entry.message.content);
		if (text.trim()) return text;
	}

	return undefined;
}

function getPreview(code: string): string {
	const line = code
		.split(/\r?\n/)
		.find((candidate) => candidate.trim().length > 0)
		?.trim();

	if (!line) return "(empty)";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function extractCodeBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const lines = markdown.split(/\r?\n/);
	let inFence = false;
	let fenceChar = "";
	let fenceLength = 0;
	let language = "";
	let codeLines: string[] = [];

	for (const line of lines) {
		if (!inFence) {
			const opener = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
			if (!opener) continue;

			inFence = true;
			fenceChar = opener[1][0];
			fenceLength = opener[1].length;
			language = opener[2].trim().split(/\s+/)[0] ?? "";
			codeLines = [];
			continue;
		}

		const closingFence = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
		if (closingFence.test(line)) {
			const code = codeLines.join("\n");
			blocks.push({
				index: blocks.length + 1,
				language,
				code,
				preview: getPreview(code),
			});
			inFence = false;
			continue;
		}

		codeLines.push(line);
	}

	return blocks;
}

function formatCodeBlockChoice(block: CodeBlock): string {
	const language = block.language || "text";
	return `${block.index}. ${language}, ${block.code.length} chars, ${block.preview}`;
}

function parseBlockIndex(args: string, blockCount: number): number | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;

	const match = trimmed.match(/^#?(\d+)$/);
	if (!match) throw new Error("Usage: /copy-code [block-number]");

	const requested = Number(match[1]);
	if (!Number.isInteger(requested) || requested < 1 || requested > blockCount) {
		throw new Error(`Block number must be between 1 and ${blockCount}.`);
	}

	return requested - 1;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "clipboard_write",
		label: "Clipboard",
		description: "Write text to the user's system clipboard. Does not read clipboard contents.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to place on the clipboard" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const command = writeClipboard(params.text);
				return {
					content: [{ type: "text", text: `Copied ${params.text.length} characters to clipboard via ${command}.` }],
					details: { command, characters: params.text.length },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Clipboard write failed: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("copy-code", {
		description: "Copy a fenced code block from the last assistant message",
		handler: async (args, ctx) => {
			const assistantText = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!assistantText) {
				ctx.ui.notify("No assistant message found to copy from.", "error");
				return;
			}

			const blocks = extractCodeBlocks(assistantText);
			if (blocks.length === 0) {
				ctx.ui.notify("The last assistant message has no fenced code blocks.", "error");
				return;
			}

			let block: CodeBlock | undefined;
			try {
				const requestedIndex = parseBlockIndex(args, blocks.length);
				if (requestedIndex !== undefined) block = blocks[requestedIndex];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				return;
			}

			if (!block && blocks.length === 1) {
				block = blocks[0];
			}

			if (!block) {
				const choices = blocks.map(formatCodeBlockChoice);
				const choice = await ctx.ui.select("Copy which code block?", choices);
				if (!choice) return;

				block = blocks[choices.indexOf(choice)];
			}

			try {
				const command = writeClipboard(block.code);
				ctx.ui.notify(`Copied code block ${block.index} (${block.code.length} chars) via ${command}.`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Clipboard write failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("clip", {
		description: "Copy the provided text to the system clipboard",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /clip text to copy", "error");
				return;
			}

			try {
				const command = writeClipboard(args);
				ctx.ui.notify(`Copied ${args.length} characters to clipboard via ${command}.`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Clipboard write failed: ${message}`, "error");
			}
		},
	});
}
