/**
 * Credential Scrubber Extension
 *
 * Instructs the agent to detect credentials and scrub them from persisted
 * plaintext session fields without modifying opaque provider payloads.
 */

import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";

const SCRUB_INSTRUCTIONS = `
## Credential Detection

If you notice an actual secret such as a password, API key, token, private key, or connection string in the conversation, do the following:

1. Point it out to the user briefly.
2. Call the \`scrub_credential\` tool with the exact string to scrub immediately, no confirmation needed.

Do NOT redact or modify credentials yourself in your response text. Always use the tool so the session file is rewritten on disk.

Database names, usernames, hostnames, identifiers, and other non-secret configuration values are not credentials and must not be scrubbed.
`;

const REDACTION = "[REDACTED]";
const MIN_CREDENTIAL_LENGTH = 12;
const MAX_PLAINTEXT_OCCURRENCES = 100;
const OPAQUE_FIELDS = new Set([
	"encrypted_content",
	"encryptedContent",
	"textSignature",
	"thinking_signature",
	"thinkingSignature",
	"thoughtSignature",
]);

interface ScrubResult {
	content: string;
	occurrences: number;
}

interface ScrubbedValue {
	value: unknown;
	occurrences: number;
}

function isSignedContentBlock(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	if (record.type === "thinking" && typeof record.thinkingSignature === "string") {
		return true;
	}

	return record.type === "text" && typeof record.textSignature === "string";
}

function isSignedToolCall(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	return record.type === "toolCall" && typeof record.thoughtSignature === "string";
}

function scrubJsonValue(value: unknown, credential: string): ScrubbedValue {
	if (typeof value === "string") {
		const occurrences = value.split(credential).length - 1;
		return {
			value: value.replaceAll(credential, REDACTION),
			occurrences,
		};
	}

	if (Array.isArray(value)) {
		const scrubbedItems: unknown[] = [];
		let occurrences = 0;

		for (const item of value) {
			const scrubbed = scrubJsonValue(item, credential);
			occurrences += scrubbed.occurrences;

			// Signed provider content is opaque state. Drop a text or thinking block
			// containing a plaintext credential instead of invalidating its signature.
			if (isSignedContentBlock(item) && scrubbed.occurrences > 0) {
				continue;
			}

			// A signed tool call cannot be changed or omitted independently from its
			// tool result. Refuse the complete mutation instead.
			if (isSignedToolCall(item) && scrubbed.occurrences > 0) {
				throw new Error("A signed tool call contains the credential; nothing was changed.");
			}

			scrubbedItems.push(scrubbed.value);
		}

		return { value: scrubbedItems, occurrences };
	}

	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const scrubbedRecord = Object.create(null) as Record<string, unknown>;
		let occurrences = 0;

		for (const [key, child] of Object.entries(record)) {
			if (OPAQUE_FIELDS.has(key)) {
				scrubbedRecord[key] = child;
				continue;
			}

			const scrubbed = scrubJsonValue(child, credential);
			scrubbedRecord[key] = scrubbed.value;
			occurrences += scrubbed.occurrences;
		}

		return { value: scrubbedRecord, occurrences };
	}

	return { value, occurrences: 0 };
}

function scrubSessionJsonl(raw: string, credential: string): ScrubResult {
	if (credential.trim().length < MIN_CREDENTIAL_LENGTH) {
		throw new Error(`Credential must be at least ${MIN_CREDENTIAL_LENGTH} characters to avoid broad replacements.`);
	}

	const outputLines: string[] = [];
	let occurrences = 0;
	const lines = raw.split("\n");

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim().length === 0) {
			outputLines.push(line);
			continue;
		}

		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new Error(`Session line ${index + 1} is not valid JSON; nothing was changed.`);
		}

		const scrubbed = scrubJsonValue(entry, credential);
		occurrences += scrubbed.occurrences;
		if (occurrences > MAX_PLAINTEXT_OCCURRENCES) {
			throw new Error(
				`Refusing to replace more than ${MAX_PLAINTEXT_OCCURRENCES} plaintext occurrences; the value is probably not a credential.`,
			);
		}

		if (scrubbed.occurrences === 0) {
			outputLines.push(line);
		} else {
			outputLines.push(JSON.stringify(scrubbed.value));
		}
	}

	return {
		content: outputLines.join("\n"),
		occurrences,
	};
}

export const credentialScrubberTestApi = {
	scrubSessionJsonl,
};

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
			"Scrub an actual secret from plaintext fields in the persisted session. Opaque encrypted provider data is never modified. Values shorter than 12 characters or appearing more than 100 times are refused.",
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

			// ASVS 15.4.1: keep the session read and replacement write in one mutation window.
			return withFileMutationQueue(sessionFile, async () => {
				let raw: string;
				try {
					raw = readFileSync(sessionFile, "utf8");
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to read session file: ${err.message}` }],
						details: { scrubbed: false, reason: "read error", error: err.message },
					};
				}

				let result: ScrubResult;
				try {
					result = scrubSessionJsonl(raw, value);
				} catch (err: any) {
					return {
						content: [{ type: "text", text: err.message }],
						details: { scrubbed: false, reason: "unsafe replacement", error: err.message },
					};
				}

				if (result.occurrences === 0) {
					return {
						content: [{ type: "text", text: "Value not found in plaintext session fields. Nothing was changed." }],
						details: { scrubbed: false, reason: "not found" },
					};
				}

				try {
					writeFileSync(sessionFile, result.content, "utf8");
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to write session file: ${err.message}` }],
						details: { scrubbed: false, reason: "write error", error: err.message },
					};
				}

				let occurrenceLabel = "occurrences";
				if (result.occurrences === 1) {
					occurrenceLabel = "occurrence";
				}

				return {
					content: [
						{
							type: "text",
							text: `Done. Replaced ${result.occurrences} ${occurrenceLabel} of the credential with ${REDACTION} in plaintext session fields.`,
						},
					],
					details: { scrubbed: true, occurrences: result.occurrences },
				};
			});
		},
	});
}
