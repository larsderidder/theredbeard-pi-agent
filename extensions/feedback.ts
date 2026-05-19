import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function getLastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role !== "assistant") continue;

		const assistant = message as AssistantMessage;
		if (assistant.stopReason !== "stop") return undefined;

		const text = assistant.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		return text || undefined;
	}
	return undefined;
}

function quoteText(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function buildFeedbackTemplate(text: string): string {
	return [
		quoteText(text),
		"",
		"Feedback:",
		"- ",
		"",
		"Follow-up prompt:",
		"",
	].join("\n");
}

function addWaitFlagIfNeeded(editorCmd: string): string {
	const trimmed = editorCmd.trim();
	if (!trimmed) return trimmed;
	if (/\b--wait\b|\b-w\b/.test(trimmed)) return trimmed;

	const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
	const base = path.basename(firstToken);

	if (["code", "code-insiders", "codium", "cursor", "windsurf", "zed"].includes(base)) {
		return `${trimmed} --wait`;
	}
	if (["subl", "mate", "emacsclient"].includes(base)) {
		return `${trimmed} -w`;
	}
	if (base === "gvim") {
		return `${trimmed} -f`;
	}

	return trimmed;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function editWithExternalEditor(initialText: string): string {
	const configuredEditor = process.env.VISUAL || process.env.EDITOR;
	if (!configuredEditor) {
		throw new Error("No editor configured. Set $VISUAL or $EDITOR.");
	}

	const editorCmd = addWaitFlagIfNeeded(configuredEditor);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-feedback-"));
	const tmpFile = path.join(tmpDir, "feedback.md");

	try {
		fs.writeFileSync(tmpFile, initialText, { encoding: "utf-8", mode: 0o600 });
		const command = `${editorCmd} ${shellQuote(tmpFile)}`;
		const result = spawnSync(command, {
			stdio: "inherit",
			shell: true,
		});

		if (result.status !== 0) {
			throw new Error(`Editor exited with status ${result.status ?? "unknown"}`);
		}

		return fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	}
}

function registerFeedbackCommand(pi: ExtensionAPI, name: string) {
	pi.registerCommand(name, {
		description: "Open the last assistant message in $EDITOR and load a feedback draft into the editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`${name} requires interactive mode`, "error");
				return;
			}

			const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!lastAssistantText) {
				ctx.ui.notify("No completed assistant message found on the current branch", "error");
				return;
			}

			try {
				const editedText = editWithExternalEditor(buildFeedbackTemplate(lastAssistantText));
				ctx.ui.setEditorText(editedText);
				ctx.ui.notify("Loaded feedback draft into the editor", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default function feedbackExtension(pi: ExtensionAPI) {
	registerFeedbackCommand(pi, "feedback");
	registerFeedbackCommand(pi, "comment");
}
