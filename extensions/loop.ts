/**
 * Loop Extension
 *
 * Provides a /loop command that starts a follow-up loop with a breakout condition.
 * The loop keeps sending a prompt on turn end until the agent calls the
 * signal_loop_success tool.
 */

import { Type } from "@sinclair/typebox";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";

type LoopMode = "tests" | "todos" | "custom" | "self";

type LoopStateData = {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
	autoCommit?: boolean;
};

const LOOP_PRESETS = [
	{ value: "tests", label: "Until tests pass", description: "" },
	{ value: "todos", label: "Until all todos done", description: "" },
	{ value: "todos-tagged", label: "Until todos with tag done", description: "" },
	{ value: "custom", label: "Until custom condition", description: "" },
	{ value: "self", label: "Self driven (agent decides)", description: "" },
] as const;

const LOOP_STATE_ENTRY = "loop-state";

const HAIKU_MODEL_ID = "claude-haiku-4-5";

const SUMMARY_SYSTEM_PROMPT = `You summarize loop breakout conditions for a status widget.
Return a concise phrase (max 6 words) that says when the loop should stop.
Use plain text only, no quotes, no punctuation, no prefix.

Form should be "breaks when ...", "loops until ...", "stops on ...", "runs until ...", or similar.
Use the best form that makes sense for the loop condition.
`;

function buildPrompt(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return (
				"Run all tests. If they are passing, call the signal_loop_success tool. " +
				"Otherwise continue until the tests pass."
			);
		case "todos": {
			const tag = condition?.trim();
			const scope = tag ? `open todos tagged "${tag}"` : "open todos";
			const filter = tag ? ` Focus only on todos that have the "${tag}" tag.` : "";
			return (
				`List ${scope} with the todo tool. Pick an unclaimed one, claim it, work on it, then close it.${filter} ` +
				`After completing a todo, check if any ${scope} remain. ` +
				`If none remain, call the signal_loop_success tool. ` +
				`Otherwise, your work for this iteration is done and you should wait for the next loop iteration.`
			);
		}
		case "custom": {
			const customCondition = condition?.trim() || "the custom condition is satisfied";
			return (
				`Continue until the following condition is satisfied: ${customCondition}. ` +
				"When it is satisfied, call the signal_loop_success tool."
			);
		}
		case "self":
			return "Continue until you are done. When finished, call the signal_loop_success tool.";
	}
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "todos": {
			const tag = condition?.trim();
			return tag ? `all "${tag}" todos done` : "all todos done";
		}
		case "custom": {
			const summary = condition?.trim() || "custom condition";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case "self":
			return "done";
	}
}

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "todos": {
			const tag = condition?.trim();
			return tag ? `all todos tagged "${tag}" are done` : "all todos are done";
		}
		case "custom":
			return condition?.trim() || "custom condition";
		case "self":
			return "you are done";
	}
}

async function selectSummaryModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	if (!ctx.model) return null;

	if (ctx.model.provider === "anthropic") {
		const haikuModel = ctx.modelRegistry.find("anthropic", HAIKU_MODEL_ID);
		if (haikuModel) {
			const apiKey = await ctx.modelRegistry.getApiKey(haikuModel);
			if (apiKey) {
				return { model: haikuModel, apiKey };
			}
		}
	}

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	return { model: ctx.model, apiKey };
}

async function summarizeBreakoutCondition(
	ctx: ExtensionContext,
	mode: LoopMode,
	condition?: string,
): Promise<string> {
	const fallback = summarizeCondition(mode, condition);
	const selection = await selectSummaryModel(ctx);
	if (!selection) return fallback;

	const conditionText = getConditionText(mode, condition);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: conditionText }],
		timestamp: Date.now(),
	};

	const response = await complete(
		selection.model,
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: selection.apiKey },
	);

	if (response.stopReason === "aborted" || response.stopReason === "error") {
		return fallback;
	}

	const summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (!summary) return fallback;
	return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
}

function getCompactionInstructions(mode: LoopMode, condition?: string): string {
	const conditionText = getConditionText(mode, condition);
	return `Loop active. Breakout condition: ${conditionText}. Preserve this loop state and breakout condition in the summary.`;
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
	if (!ctx.hasUI) return;
	if (!state.active || !state.mode) {
		ctx.ui.setWidget("loop", undefined);
		return;
	}
	const loopCount = state.loopCount ?? 0;
	const turnText = `(turn ${loopCount})`;
	const summary = state.summary?.trim();
	const text = summary
		? `Loop active: ${summary} ${turnText}`
		: `Loop active ${turnText}`;
	ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", text)]);
}

async function loadState(ctx: ExtensionContext): Promise<LoopStateData> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
		if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
	let loopState: LoopStateData = { active: false };

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		const cleared: LoopStateData = { active: false };
		loopState = cleared;
		persistState(cleared);
		updateStatus(ctx, cleared);
	}

	function breakLoop(ctx: ExtensionContext): void {
		clearLoopState(ctx);
		ctx.ui.notify("Loop ended", "info");
	}

	function wasLastAssistantAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				return message.stopReason === "aborted";
			}
		}
		return false;
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage({
			customType: "loop",
			content: loopState.prompt,
			display: true
		}, {
			deliverAs: "followUp",
			triggerTurn: true
		});
	}

	async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
		const items: SelectItem[] = LOOP_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));

		const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select a loop preset"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selection) return null;

		// Ask about auto-commit for todo loops
		let autoCommit = false;
		if (selection === "todos" || selection === "todos-tagged") {
			autoCommit = await ctx.ui.confirm("Auto-commit?", "Automatically commit after each completed todo?");
		}

		switch (selection) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests"), autoCommit: false };
			case "todos":
				return { active: true, mode: "todos", prompt: buildPrompt("todos"), autoCommit };
			case "todos-tagged": {
				const tag = await ctx.ui.input("Tag to filter todos by:");
				if (!tag?.trim()) return null;
				const trimmedTag = tag.trim();
				return {
					active: true,
					mode: "todos",
					condition: trimmedTag,
					prompt: buildPrompt("todos", trimmedTag),
					autoCommit,
				};
			}
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self"), autoCommit: false };
			case "custom": {
				const condition = await ctx.ui.editor("Enter loop breakout condition:", "");
				if (!condition?.trim()) return null;
				return {
					active: true,
					mode: "custom",
					condition: condition.trim(),
					prompt: buildPrompt("custom", condition.trim()),
					autoCommit: false,
				};
			}
			default:
				return null;
		}
	}

	function parseArgs(args: string | undefined): LoopStateData | null {
		if (!args?.trim()) return null;
		const parts = args.trim().split(/\s+/);
		const mode = parts[0]?.toLowerCase();

		// Check for --no-commit flag
		const hasNoCommit = parts.includes("--no-commit");
		const filteredParts = parts.filter(p => p !== "--no-commit");
		const autoCommit = !hasNoCommit;

		switch (mode) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests"), autoCommit: false };
			case "todos": {
				const tag = filteredParts.slice(1).join(" ").trim() || undefined;
				return {
					active: true,
					mode: "todos",
					condition: tag,
					prompt: buildPrompt("todos", tag),
					autoCommit,
				};
			}
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self"), autoCommit: false };
			case "custom": {
				const condition = filteredParts.slice(1).join(" ").trim();
				if (!condition) return null;
				return {
					active: true,
					mode: "custom",
					condition,
					prompt: buildPrompt("custom", condition),
					autoCommit: false,
				};
			}
			default:
				return null;
		}
	}

	pi.registerTool({
		name: "signal_loop_success",
		label: "Signal Loop Success",
		description: "Stop the active loop when the breakout condition is satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!loopState.active) {
				return {
					content: [{ type: "text", text: "No active loop is running." }],
					details: { active: false },
				};
			}

			clearLoopState(ctx);

			return {
				content: [{ type: "text", text: "Loop ended." }],
				details: { active: false },
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Start a follow-up loop until a breakout condition is met",
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop tests | /loop todos [tag] | /loop custom <condition> | /loop self", "warning");
					return;
				}
				nextState = await showLoopSelector(ctx);
			}

			if (!nextState) {
				ctx.ui.notify("Loop cancelled", "info");
				return;
			}

			if (loopState.active) {
				const confirm = ctx.hasUI
					? await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?")
					: true;
				if (!confirm) {
					ctx.ui.notify("Loop unchanged", "info");
					return;
				}
			}

			const summarizedState: LoopStateData = { ...nextState, summary: undefined, loopCount: 0 };
			setLoopState(summarizedState, ctx);
			ctx.ui.notify("Loop active", "info");
			triggerLoopPrompt(ctx);

			const mode = nextState.mode!;
			const condition = nextState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				"Break active loop?",
				"Operation aborted. Break out of the loop?",
			);
			if (confirm) {
				breakLoop(ctx);
				return;
			}
		}

		triggerLoopPrompt(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) return;

		const instructionParts = [event.customInstructions, getCompactionInstructions(loopState.mode, loopState.condition)]
			.filter(Boolean)
			.join("\n\n");

		try {
			const compaction = await compact(event.preparation, ctx.model, apiKey, instructionParts, event.signal);
			return { compaction };
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Loop compaction failed: ${message}`, "warning");
			}
			return;
		}
	});

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = await loadState(ctx);
		updateStatus(ctx, loopState);

		if (loopState.active && loopState.mode && !loopState.summary) {
			const mode = loopState.mode;
			const condition = loopState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreLoopState(ctx);
	});

	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		await restoreLoopState(ctx);
	});

	let justCommitted = false;

	pi.on("tool_result", async (event, ctx) => {
		if (!loopState.active) return;
		// Skip if auto-commit is disabled
		if (!loopState.autoCommit) return;
		if (event.toolName !== "todo") return;
		
		// Check if this was a successful todo close operation
		const input = event.input as { action?: string; id?: string; status?: string; title?: string };
		
		// Only commit when a todo is closed (status changed to "closed" or deleted)
		const isClosed = (input.action === "update" && input.status === "closed") || 
		                 (input.action === "delete");
		
		if (!isClosed) return;
		
		// Check if the todo tool indicated success
		if (event.isError) return;
		
		// Extract todo information
		const todoId = input.id;
		const todoTitle = input.title;
		if (!todoId) return;
		
		// Check for unstaged changes
		const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
		if (statusResult.code !== 0 || !statusResult.stdout.trim()) {
			return; // No changes to commit
		}
		
		// Build commit instruction message
		let commitInstruction: string;
		if (todoTitle) {
			// Use the todo title as guidance for the commit message
			commitInstruction = `/skill:commit ${todoTitle}`;
		} else {
			// Fallback to generic instruction
			commitInstruction = `/skill:commit Complete todo ${todoId}`;
		}
		
		// Queue the commit as a follow-up message
		justCommitted = true;
		pi.sendUserMessage(commitInstruction, { deliverAs: "followUp" });
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				"Break active loop?",
				"Operation aborted. Break out of the loop?",
			);
			if (confirm) {
				breakLoop(ctx);
				return;
			}
		}

		// If we just triggered a commit, skip one loop iteration
		// to let the commit complete before continuing the loop
		if (justCommitted) {
			justCommitted = false;
			return;
		}

		triggerLoopPrompt(ctx);
	});
}
