/**
 * Credential Scrubber Extension
 *
 * Instructs the agent to detect credentials in conversation and offer to scrub them.
 * The agent calls scrub_credential with the exact string, the extension confirms
 * with the user, then rewrites the session file replacing all occurrences with [REDACTED].
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";

const SCRUB_INSTRUCTIONS = `
## Credential Detection

If you notice what appears to be a credential, secret, API key, token, password, or other sensitive value in the conversation (either in user messages or tool results), do the following:

1. Point it out to the user briefly.
2. Call the \`scrub_credential\` tool with the exact string to scrub immediately, no confirmation needed.

Do NOT redact or modify credentials yourself in your response text. Always use the tool so the session file is rewritten on disk.

Examples of things to flag: API keys, bearer tokens, private keys, passwords, database connection strings, webhook secrets, OAuth tokens, AWS/GCP/Azure credentials.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + SCRUB_INSTRUCTIONS,
		};
	});

	pi.registerTool({
		name: "scrub_credential",
		label: "Scrub Credential",
		description:
			"Scrub a sensitive value from the session file on disk. Call this when you detect a credential or secret in the conversation. Replaces all occurrences with [REDACTED] immediately, no confirmation required.",
		parameters: Type.Object({
			value: Type.String({
				description: "The exact credential string to scrub from the session file.",
			}),
			description: Type.Optional(
				Type.String({
					description: "Brief description of what this credential appears to be (e.g. 'OpenAI API key', 'GitHub token').",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { value } = params;

			if (!value || value.trim().length === 0) {
				return {
					content: [{ type: "text", text: "No value provided to scrub." }],
					details: { scrubbed: false, reason: "empty value" },
				};
			}

			const sessionFile = ctx.sessionManager.getSessionFile();

			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "Session is not persisted to disk; nothing to scrub." }],
					details: { scrubbed: false, reason: "no session file" },
				};
			}

			let raw: string;
			try {
				raw = readFileSync(sessionFile, "utf8");
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to read session file: ${err.message}` }],
					details: { scrubbed: false, reason: "read error", error: err.message },
				};
			}

			// Count occurrences before replacing
			const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "g");
			const matches = (raw.match(regex) ?? []).length;

			if (matches === 0) {
				return {
					content: [{ type: "text", text: "Value not found in session file. Nothing was changed." }],
					details: { scrubbed: false, reason: "not found" },
				};
			}

			const scrubbed = raw.replace(regex, "[REDACTED]");

			try {
				writeFileSync(sessionFile, scrubbed, "utf8");
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to write session file: ${err.message}` }],
					details: { scrubbed: false, reason: "write error", error: err.message },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Done. Replaced ${matches} occurrence${matches === 1 ? "" : "s"} of the credential with [REDACTED] in the session file.`,
					},
				],
				details: { scrubbed: true, occurrences: matches },
			};
		},
	});
}
