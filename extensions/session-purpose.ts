/**
 * /purpose [text]
 *
 * Set or show a session purpose. The purpose is:
 *   - Stored as a custom entry in the session (persists across restarts)
 *   - Shown in the footer so it is always visible
 *   - Injected into the system prompt each turn so the model is aware of it
 *   - Used to guide compaction: messages relevant to the purpose are kept,
 *     tangents are discarded
 *
 * Usage:
 *   /purpose Implement the OAuth login flow end to end
 *   /purpose          <- shows the current purpose
 *   /purpose clear    <- clears the purpose
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

const CUSTOM_TYPE = "session-purpose";
const STATUS_KEY = "session-purpose";

function readPurposeFromEntries(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	let purpose: string | undefined;
	// Walk forward; last entry wins so /purpose clear followed by /purpose foo works.
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data as { purpose: string | null } | undefined;
			if (data?.purpose != null) {
				purpose = data.purpose;
			} else {
				purpose = undefined;
			}
		}
	}
	return purpose;
}

function truncate(text: string, maxLen: number): string {
	return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "\u2026";
}

export default function sessionPurposeExtension(pi: ExtensionAPI) {
	let currentPurpose: string | undefined;

	function applyPurpose(purpose: string | undefined, ctx: ExtensionContext) {
		currentPurpose = purpose;
		if (purpose) {
			ctx.ui.setStatus(STATUS_KEY, `\uD83C\uDFAF ${truncate(purpose, 60)}`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	// Restore purpose from session on startup.
	pi.on("session_start", async (_event, ctx) => {
		applyPurpose(readPurposeFromEntries(ctx), ctx);
	});

	// Restore after /fork (new file, same history).
	pi.on("session_fork", async (_event, ctx) => {
		applyPurpose(readPurposeFromEntries(ctx), ctx);
	});

	// Inject purpose into the system prompt so the model stays aware of it.
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!currentPurpose) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Session Purpose\n${currentPurpose}\n\nKeep this goal in mind when responding.`,
		};
	});

	// Steer compaction toward the purpose.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!currentPurpose) return; // no purpose, let default compaction run

		const { preparation } = event;

		const allMessages = [
			...(preparation.messagesToSummarize ?? []),
			...(preparation.turnPrefixMessages ?? []),
		];

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = preparation.previousSummary
			? `\n\nPrevious session summary:\n${preparation.previousSummary}`
			: "";

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("session-purpose: no model available, falling back to default compaction", "warning");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			ctx.ui.notify("session-purpose: no API key, falling back to default compaction", "warning");
			return;
		}

		// Any extra instructions the user passed to /compact.
		const extraInstructions = event.customInstructions
			? `\n\nAdditional instructions: ${event.customInstructions}`
			: "";

		const prompt =
			`You are a conversation summarizer. Produce a structured summary of this conversation.\n\n` +
			`Session purpose: "${currentPurpose}"\n\n` +
			`Prioritize information directly relevant to the purpose above. ` +
			`Omit tangents, exploratory dead-ends, and discussions unrelated to the purpose. ` +
			`Include everything needed to continue working toward the purpose.` +
			extraInstructions +
			`\n\nUse this format:\n\n` +
			`## Goal\n[What the user is trying to accomplish]\n\n` +
			`## Constraints & Preferences\n- [Requirements or preferences the user mentioned]\n\n` +
			`## Progress\n### Done\n- [x] [Completed tasks]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues, if any]\n\n` +
			`## Key Decisions\n- **[Decision]**: [Rationale]\n\n` +
			`## Next Steps\n1. [What should happen next]\n\n` +
			`## Critical Context\n- [Data or facts needed to continue]\n` +
			previousContext +
			`\n\n<conversation>\n${conversationText}\n</conversation>`;

		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey, maxTokens: 8192, signal: event.signal },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!event.signal.aborted) {
					ctx.ui.notify("session-purpose: empty compaction summary, using default", "warning");
				}
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		} catch (err) {
			if (!event.signal.aborted) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`session-purpose: compaction error (${message}), using default`, "error");
			}
			return;
		}
	});

	// /purpose command
	pi.registerCommand("purpose", {
		description: "Set or show the session purpose (guides compaction). Usage: /purpose [text | clear]",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (!text) {
				if (currentPurpose) {
					ctx.ui.notify(`Purpose: ${currentPurpose}`, "info");
				} else {
					ctx.ui.notify("No purpose set. Use /purpose <text> to set one, /purpose clear to remove.", "info");
				}
				return;
			}

			if (text.toLowerCase() === "clear") {
				pi.appendEntry(CUSTOM_TYPE, { purpose: null });
				applyPurpose(undefined, ctx);
				ctx.ui.notify("Session purpose cleared.", "info");
				return;
			}

			pi.appendEntry(CUSTOM_TYPE, { purpose: text });
			applyPurpose(text, ctx);
			ctx.ui.notify(`Purpose set: ${text}`, "info");
		},
	});
}
