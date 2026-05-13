/**
 * Loop Extension
 *
 * /loop            — inline loop, agent calls signal_loop_success when done
 * /loop-subagent   — isolated loop: spawns fresh `pi -p --no-session` per iteration
 *
 * /loop-subagent accepts a task script with this interface:
 *   script queue [param]              → stdout: item context, exit 0; exit 1 = all done
 *   script prompt <item> [param]      → stdout: full worker prompt for this item, exit 0
 *   script verify <item> [param]      → exit 0 = pass, exit 1 = fail (stdout: error details). Optional.
 *   script info [param]               → stdout: key=value pairs (cwd=, description=), exit 0 (optional)
 *
 * If verify is implemented and fails, the item is retried with the error details
 * appended to the prompt as correction instructions. Max 1 retry per item.
 *
 * Breakout is fully mechanical: queue exit 1 = stop. No LLM involvement.
 *
 * /loop (inline) also accepts .md task files with a ## Breakout condition section.
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "fs";
import { basename, resolve, dirname, join } from "path";
import { tmpdir } from "os";
import { spawn, execFileSync } from "child_process";
import { Type } from "@sinclair/typebox";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoopMode = "tests" | "todos" | "custom" | "self" | "file" | "script";

type LoopStateData = {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	/** Inline modes: the repeated prompt. Script mode: the script path. */
	prompt?: string;
	/** Optional parameter passed to task scripts after the command/item. */
	scriptParam?: string;
	summary?: string;
	loopCount?: number;
	autoCommit?: boolean;
	subagent?: boolean;
};

interface TaskScriptInfo {
	/** Absolute path to the script */
	scriptPath: string;
	/** Working directory to use (from `info` command, or script directory) */
	cwd: string;
	/** Human-readable description (from `info` command) */
	description?: string;
}

interface IterationToolCall {
	name: string;
	preview: string;
}

interface IterationSummary {
	iteration: number;
	item?: string;
	status: "running" | "done" | "failed";
	toolCalls: IterationToolCall[];
	finalOutput?: string;
}

interface SubagentLoopDetails {
	iterations: IterationSummary[];
	totalIterations: number;
	status: "running" | "done" | "failed" | "cancelled";
}

interface IsolatedRunResult {
	exitCode: number;
	finalOutput: string;
	error?: string;
	/** True if the failure looks like a rate limit (429 / quota exhausted). */
	rateLimited?: boolean;
}

type ProgressEvent =
	| { type: "tool_call"; name: string; args: Record<string, unknown> }
	| { type: "text"; text: string }
	| { type: "tool_result"; name: string; output: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOP_PRESETS = [
	{ value: "tests", label: "Until tests pass", description: "" },
	{ value: "todos", label: "Until all todos done", description: "" },
	{ value: "todos-tagged", label: "Until todos with tag done", description: "" },
	{ value: "custom", label: "Until custom condition", description: "" },
	{ value: "self", label: "Self driven (agent decides)", description: "" },
] as const;

const LOOP_STATE_ENTRY = "loop-state";
const HAIKU_MODEL_ID = "claude-haiku-4-5";
/** Max recent iterations to show in the live-updating tool result. */
const MAX_VISIBLE_ITERATIONS = 5;

const SUMMARY_SYSTEM_PROMPT = `You summarize loop breakout conditions for a status widget.
Return a concise phrase (max 6 words) that says when the loop should stop.
Use plain text only, no quotes, no punctuation, no prefix.

Form should be "breaks when ...", "loops until ...", "stops on ...", "runs until ...", or similar.
Use the best form that makes sense for the loop condition.
`;

// ---------------------------------------------------------------------------
// Task script helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a path is a task script (executable with queue/prompt interface)
 * vs a .md task file (which is only supported by /loop inline mode).
 */
function isTaskScript(filePath: string): boolean {
	return (
		filePath.endsWith(".py") ||
		filePath.endsWith(".sh") ||
		filePath.endsWith(".ts") ||
		filePath.endsWith(".js") ||
		filePath.endsWith(".rb") ||
		filePath.endsWith(".loop.py") ||
		filePath.endsWith(".task")
	);
}

/**
 * Resolve the interpreter and args for a task script.
 */
function getScriptInvocation(scriptPath: string): { cmd: string; args: string[] } {
	if (scriptPath.endsWith(".py")) return { cmd: "python3", args: [scriptPath] };
	if (scriptPath.endsWith(".sh")) return { cmd: "bash", args: [scriptPath] };
	if (scriptPath.endsWith(".ts")) return { cmd: "npx", args: ["tsx", scriptPath] };
	if (scriptPath.endsWith(".js")) return { cmd: "node", args: [scriptPath] };
	if (scriptPath.endsWith(".rb")) return { cmd: "ruby", args: [scriptPath] };
	// Fallback: try executing directly
	return { cmd: scriptPath, args: [] };
}

/**
 * Read optional metadata from `script info`.
 */
function readScriptInfo(scriptPath: string, cwd: string, scriptParam?: string): TaskScriptInfo {
	const inv = getScriptInvocation(scriptPath);
	const info: TaskScriptInfo = {
		scriptPath,
		cwd,
	};

	try {
		const out = execFileSync(inv.cmd, [...inv.args, "info", ...(scriptParam ? [scriptParam] : [])], {
			cwd,
			timeout: 5000,
			encoding: "utf-8",
		});
		for (const line of out.split("\n")) {
			const eq = line.indexOf("=");
			if (eq < 0) continue;
			const key = line.slice(0, eq).trim();
			const val = line.slice(eq + 1).trim();
			if (key === "cwd" && val) {
				info.cwd = val.startsWith("~")
					? val.replace("~", process.env.HOME ?? "")
					: val;
			}
			if (key === "description" && val) info.description = val;
		}
	} catch {
		// info command is optional, ignore errors
	}

	return info;
}

/**
 * Run `script queue` to get the next item.
 * Returns the item string (stdout) if exit 0, null if exit 1 (all done),
 * throws on unexpected errors.
 */
function runScriptQueue(
	scriptPath: string,
	cwd: string,
	signal?: AbortSignal,
	scriptParam?: string,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const inv = getScriptInvocation(scriptPath);
		const proc = spawn(inv.cmd, [...inv.args, "queue", ...(scriptParam ? [scriptParam] : [])], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		proc.on("close", (code) => {
			if (code === 1) {
				resolve(null); // all done
			} else if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`queue exited ${code}: ${stderr.trim() || stdout.trim()}`));
			}
		});

		proc.on("error", (err) => reject(err));

		if (signal) {
			const kill = () => proc.kill("SIGTERM");
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/**
 * Run `script prompt <item>` to get the worker prompt.
 */
function runScriptPrompt(
	scriptPath: string,
	cwd: string,
	item: string,
	scriptParam?: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const inv = getScriptInvocation(scriptPath);
		const proc = spawn(inv.cmd, [...inv.args, "prompt", item, ...(scriptParam ? [scriptParam] : [])], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		proc.on("close", (code) => {
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`prompt exited ${code}: ${stderr.trim() || "(no output)"}`));
			}
		});

		proc.on("error", (err) => reject(err));
	});
}

/**
 * Run `script verify <item>` to check the worker's output.
 * Returns null if verify passed or if the script doesn't implement verify.
 * Returns an error string if verification failed.
 */
function runScriptVerify(
	scriptPath: string,
	cwd: string,
	item: string,
	scriptParam?: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		const inv = getScriptInvocation(scriptPath);
		const proc = spawn(inv.cmd, [...inv.args, "verify", item, ...(scriptParam ? [scriptParam] : [])], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		proc.on("close", (code) => {
			if (code === 0) {
				resolve(null); // passed
			} else if (code === 1) {
				resolve(stdout.trim() || stderr.trim() || "Verification failed"); // failed with details
			} else {
				// Exit code 2 or other = verify not implemented, treat as pass
				resolve(null);
			}
		});

		proc.on("error", () => {
			// Script doesn't support verify, treat as pass
			resolve(null);
		});
	});
}

// ---------------------------------------------------------------------------
// .md task file helper (for /loop inline mode only)
// ---------------------------------------------------------------------------

function parseLoopFile(filePath: string, cwd: string): { task: string; breakout: string } | null {
	const resolved = resolve(cwd, filePath);
	if (!existsSync(resolved)) return null;

	let content: string;
	try {
		content = readFileSync(resolved, "utf-8");
	} catch {
		return null;
	}

	const breakoutMatch = content.match(/^##\s+Breakout condition\s*\n([\s\S]*?)(?=\n##\s|\s*$)/im);
	const breakout = breakoutMatch ? breakoutMatch[1].trim() : "";
	if (!breakout) return null;
	return { task: content.trim(), breakout };
}

// ---------------------------------------------------------------------------
// Prompt builders (for /loop inline modes)
// ---------------------------------------------------------------------------

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
		case "file": {
			const breakout = condition?.trim() || "the task is complete";
			return (
				`Continue until the following condition is satisfied: ${breakout}. ` +
				"When it is satisfied, call the signal_loop_success tool."
			);
		}
		case "script":
			return ""; // script mode builds prompts dynamically
	}
}

// ---------------------------------------------------------------------------
// Condition summarizers (for status widget)
// ---------------------------------------------------------------------------

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests": return "tests pass";
		case "todos": {
			const tag = condition?.trim();
			return tag ? `all "${tag}" todos done` : "all todos done";
		}
		case "custom": {
			const summary = condition?.trim() || "custom condition";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case "self": return "done";
		case "file": {
			const summary = condition?.trim() || "file task complete";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case "script": {
			const summary = condition?.trim() || "queue exhausted";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
	}
}

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests": return "tests pass";
		case "todos": {
			const tag = condition?.trim();
			return tag ? `all todos tagged "${tag}" are done` : "all todos are done";
		}
		case "custom": return condition?.trim() || "custom condition";
		case "self": return "you are done";
		case "file": return condition?.trim() || "the file task is complete";
		case "script": return condition?.trim() || "the queue is exhausted";
	}
}

// ---------------------------------------------------------------------------
// Summary model helpers
// ---------------------------------------------------------------------------

async function selectSummaryModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	if (!ctx.model) return null;

	const getKey = async (model: Model<Api>): Promise<string | null> => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		return auth.ok && auth.apiKey ? auth.apiKey : null;
	};

	if (ctx.model.provider === "anthropic") {
		const haikuModel = ctx.modelRegistry.find("anthropic", HAIKU_MODEL_ID);
		if (haikuModel) {
			const apiKey = await getKey(haikuModel);
			if (apiKey) return { model: haikuModel, apiKey };
		}
	}

	const apiKey = await getKey(ctx.model);
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

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

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
	const summary = state.summary?.trim();
	const text = summary
		? `Loop active: ${summary} (turn ${loopCount})`
		: `Loop active (turn ${loopCount})`;
	ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", text)]);
}

function formatToolPreview(name: string, args: Record<string, unknown>): string {
	const shortenPath = (p: string) => {
		const home = process.env.HOME || "";
		return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "...");
			return `$ ${cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd}`;
		}
		case "read":   return `read ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
		case "write":  return `write ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
		case "edit":   return `edit ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.length > 40 ? `${s.slice(0, 40)}...` : s}`;
		}
	}
}

// ---------------------------------------------------------------------------
// Session state persistence
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pi invocation helper
// ---------------------------------------------------------------------------

function getPiCommand(): { command: string; baseArgs: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, baseArgs: [currentScript] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, baseArgs: [] };
	return { command: "pi", baseArgs: [] };
}

// ---------------------------------------------------------------------------
// Isolated iteration runner
// ---------------------------------------------------------------------------

function runIsolatedIteration(
	prompt: string,
	cwd: string,
	model?: string,
	signal?: AbortSignal,
	onProgress?: (event: ProgressEvent) => void,
): Promise<IsolatedRunResult> {
	// Write prompt to a temp file and use @file syntax to avoid ARG_MAX (E2BIG) errors
	// for large prompts.
	let tmpDir: string | null = null;
	let tmpFile: string | null = null;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-loop-"));
		tmpFile = join(tmpDir, "prompt.md");
		writeFileSync(tmpFile, prompt, { encoding: "utf-8", mode: 0o600 });
	} catch {
		tmpDir = null;
		tmpFile = null;
	}

	return new Promise<IsolatedRunResult>((resolve) => {
		const piCmd = getPiCommand();
		const args = [...piCmd.baseArgs, "--mode", "json", "-p", "--no-session"];
		if (model) args.push("--model", model);
		// Use @file if we wrote the temp file, fall back to inline arg
		args.push(tmpFile ? `@${tmpFile}` : prompt);

		const proc = spawn(piCmd.command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		let lastAssistantText = "";
		let buffer = "";
		let rateLimited = false;

		const RATE_LIMIT_RE = /rate.?limit|too many requests|429|quota|resource.?exhausted/i;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }

			if (event.type === "message_end" && event.message?.role === "assistant") {
				const content = event.message.content;
				const errorMessage: string = event.message.errorMessage ?? "";
				if (RATE_LIMIT_RE.test(errorMessage)) rateLimited = true;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (part.type === "text") lastAssistantText = part.text;
						if (onProgress && part.type === "toolCall") {
							onProgress({ type: "tool_call", name: part.name, args: part.arguments ?? {} });
						}
					}
				}
			}

			// auto_retry_end with success=false means pi gave up retrying — likely rate limited
			if (event.type === "auto_retry_end" && event.success === false) {
				const finalError: string = event.finalError ?? "";
				if (RATE_LIMIT_RE.test(finalError)) rateLimited = true;
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

		const cleanup = () => {
			try { if (tmpFile) unlinkSync(tmpFile); } catch { /* ignore */ }
			try { if (tmpDir) rmdirSync(tmpDir); } catch { /* ignore */ }
		};

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			// Also check stderr for rate limit signals (some providers write there)
			if (RATE_LIMIT_RE.test(stderr)) rateLimited = true;
			cleanup();
			resolve({
				exitCode: code ?? 0,
				finalOutput: lastAssistantText,
				error: stderr.trim() || undefined,
				rateLimited,
			});
		});

		proc.on("error", (err) => {
			cleanup();
			resolve({ exitCode: 1, finalOutput: "", error: err.message });
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function loopExtension(pi: ExtensionAPI): void {
	let loopState: LoopStateData = { active: false };
	let subagentAbort: AbortController | null = null;
	let awaitingSubagentTrigger = false;

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		loopState = { active: false };
		persistState(loopState);
		updateStatus(ctx, loopState);
		awaitingSubagentTrigger = false;
		if (subagentAbort) {
			subagentAbort.abort();
			subagentAbort = null;
		}
	}

	function breakLoop(ctx: ExtensionContext): void {
		clearLoopState(ctx);
		ctx.ui.notify("Loop ended", "info");
	}

	function wasLastAssistantAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") return msg.stopReason === "aborted";
		}
		return false;
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;
		if (loopState.subagent) return; // subagent mode uses runSubagentLoop

		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage({
			customType: "loop",
			content: loopState.prompt,
			display: true,
		}, { deliverAs: "followUp", triggerTurn: true });
	}

	// -------------------------------------------------------------------------
	// Subagent loop runner
	// -------------------------------------------------------------------------

	async function runSubagentLoop(
		ctx: ExtensionContext,
		signal: AbortSignal,
		onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentLoopDetails }) => void,
	): Promise<SubagentLoopDetails> {
		const loopDetails: SubagentLoopDetails = {
			iterations: [],
			totalIterations: 0,
			status: "running",
		};

		const emitUpdate = (text?: string) => {
			if (!onUpdate) return;
			onUpdate({
				content: [{ type: "text", text: text ?? `Running... (${loopDetails.totalIterations} iterations)` }],
				details: { ...loopDetails, iterations: [...loopDetails.iterations] },
			});
		};

		const scriptPath = loopState.prompt!;
		const scriptParam = loopState.scriptParam;
		const iterCwd = readScriptInfo(scriptPath, ctx.cwd, scriptParam).cwd;

		while (loopState.active && loopState.subagent) {
			const loopCount = (loopState.loopCount ?? 0) + 1;
			loopState = { ...loopState, loopCount };
			persistState(loopState);
			updateStatus(ctx, loopState);

			let item: string | null;
			try {
				item = await runScriptQueue(scriptPath, iterCwd, signal, scriptParam);
			} catch (err) {
				ctx.ui.notify(`Queue error: ${err instanceof Error ? err.message : String(err)}`, "warning");
				loopDetails.status = "failed";
				break;
			}

			if (item === null) {
				// Queue exhausted — all done
				loopDetails.status = "done";
				const completed = loopCount - 1;
				emitUpdate(`Completed after ${completed} iteration${completed === 1 ? "" : "s"}`);
				clearLoopState(ctx);
				loopState = { ...loopState, loopCount: completed };
				persistState(loopState);
				ctx.ui.notify(`Loop complete after ${completed} iteration${completed === 1 ? "" : "s"}`, "info");
				break;
			}

			const itemLabel = item.split("\n")[0].trim().slice(0, 60);

			let workerPrompt: string;
			try {
				workerPrompt = await runScriptPrompt(scriptPath, iterCwd, item, scriptParam);
			} catch (err) {
				ctx.ui.notify(`Prompt error: ${err instanceof Error ? err.message : String(err)}`, "warning");
				loopDetails.status = "failed";
				break;
			}

			const iter: IterationSummary = {
				iteration: loopCount,
				item: itemLabel,
				status: "running",
				toolCalls: [],
			};
			loopDetails.iterations.push(iter);
			loopDetails.totalIterations = loopCount;

			if (loopDetails.iterations.length > MAX_VISIBLE_ITERATIONS) {
				loopDetails.iterations = loopDetails.iterations.slice(-MAX_VISIBLE_ITERATIONS);
			}

			emitUpdate();

			const modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			const onProgress = (event: ProgressEvent) => {
				if (event.type !== "tool_call") return;
				const preview = formatToolPreview(event.name, event.args);
				iter.toolCalls.push({ name: event.name, preview });
				if (ctx.hasUI) {
					const label = itemLabel ? ` [${itemLabel}]` : "";
					ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", `Iter ${loopCount}${label}: ${preview}`)]);
				}
				emitUpdate();
			};

			const result = await runIsolatedIteration(workerPrompt, iterCwd, modelId, signal, onProgress);

			if (!loopState.active || signal.aborted) {
				loopDetails.status = "cancelled";
				emitUpdate("Loop cancelled");
				break;
			}

			iter.finalOutput = result.finalOutput;
			iter.status = result.exitCode !== 0 ? "failed" : "done";
			emitUpdate();

			// Post-worker verification: run `script verify <item>` if available
			if (iter.status === "done") {
				const verifyError = await runScriptVerify(scriptPath, iterCwd, item, scriptParam);
				if (verifyError) {
					// Verification failed — retry once with error feedback
					iter.status = "failed";
					iter.finalOutput += `\n\nVERIFICATION FAILED: ${verifyError}`;
					emitUpdate();

					const retryPrompt = `${workerPrompt}\n\n## IMPORTANT: Previous attempt failed verification\n\nThe previous extraction was rejected for the following reason:\n${verifyError}\n\nPlease fix these issues in your extraction. Read the source file again and produce a corrected JSON output.`;

					const retryResult = await runIsolatedIteration(retryPrompt, iterCwd, modelId, signal, onProgress);

					if (retryResult.exitCode === 0) {
						// Check again
						const retryVerify = await runScriptVerify(scriptPath, iterCwd, item, scriptParam);
						if (!retryVerify) {
							iter.status = "done";
							iter.finalOutput = retryResult.finalOutput + " (fixed after retry)";
						} else {
							iter.status = "failed";
							iter.finalOutput = `Retry also failed verification: ${retryVerify}`;
						}
					} else {
						iter.status = "failed";
						iter.finalOutput = `Retry failed with exit code ${retryResult.exitCode}`;
					}
					emitUpdate();
				}
			}

			// Write a visible per-iteration summary to the session
			{
				const icon = iter.status === "done" ? "✓" : "✗";
				const toolSummary = iter.toolCalls.map((tc) => tc.preview).join(", ");
				const outputPreview = iter.finalOutput.trim().slice(0, 100);
				const lines = [`${icon} Iteration ${loopCount}${itemLabel ? ` — ${itemLabel}` : ""}`];
				if (toolSummary) lines.push(`  ${toolSummary}`);
				if (outputPreview) lines.push(`  ${outputPreview}${iter.finalOutput.trim().length > 100 ? "..." : ""}`);
				pi.sendMessage({
					customType: "loop-iteration",
					content: lines.join("\n"),
					display: true,
					details: { ...iter },
				});
			}

			if (result.rateLimited) {
				// Exponential backoff: 60s, 120s, 240s... capped at 10 minutes
				const consecutiveFails = loopDetails.iterations.filter(
					(it) => it.status === "failed",
				).length;
				const backoffMs = Math.min(60_000 * 2 ** (consecutiveFails - 1), 600_000);
				const backoffSec = Math.round(backoffMs / 1000);
				ctx.ui.notify(`Rate limited — waiting ${backoffSec}s before next iteration`, "warning");
				if (ctx.hasUI) {
					ctx.ui.setWidget("loop", [ctx.ui.theme.fg("warning", `Rate limited — retrying in ${backoffSec}s`)]);
				}
				await new Promise((r) => setTimeout(r, backoffMs));
			} else {
				await new Promise((r) => setTimeout(r, 500));
			}
		}

		if (loopDetails.status === "running") loopDetails.status = "done";
		return loopDetails;
	}

	// -------------------------------------------------------------------------
	// UI: loop selector
	// -------------------------------------------------------------------------

	async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
		const items: SelectItem[] = LOOP_PRESETS.map((p) => ({
			value: p.value,
			label: p.label,
			description: p.description,
		}));

		const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select a loop preset"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText:   (text) => theme.fg("accent", text),
				description:    (text) => theme.fg("muted", text),
				scrollInfo:     (text) => theme.fg("dim", text),
				noMatch:        (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) { return container.render(width); },
				invalidate() { container.invalidate(); },
				handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		if (!selection) return null;

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
				return { active: true, mode: "todos", condition: tag.trim(), prompt: buildPrompt("todos", tag.trim()), autoCommit };
			}
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self"), autoCommit: false };
			case "custom": {
				const condition = await ctx.ui.editor("Enter loop breakout condition:", "");
				if (!condition?.trim()) return null;
				return { active: true, mode: "custom", condition: condition.trim(), prompt: buildPrompt("custom", condition.trim()), autoCommit: false };
			}
			default:
				return null;
		}
	}

	// -------------------------------------------------------------------------
	// Argument parser
	// -------------------------------------------------------------------------

	function splitArgs(input: string): string[] {
		const parts: string[] = [];
		const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(input)) !== null) {
			parts.push(match[1] ?? match[2] ?? match[3] ?? "");
		}
		return parts;
	}

	function parseArgs(args: string | undefined): LoopStateData | null {
		if (!args?.trim()) return null;
		const parts = splitArgs(args.trim());

		const hasNoCommit = parts.includes("--no-commit");
		const filteredParts = parts.filter((p) => p !== "--no-commit");
		const autoCommit = !hasNoCommit;

		const firstArg = filteredParts[0] ?? "";
		const scriptParam = filteredParts.slice(1).join(" ").trim() || undefined;
		const filePath = firstArg;
		const looksLikePath =
			firstArg.includes("/") ||
			firstArg.includes("\\") ||
			firstArg.endsWith(".md") ||
			firstArg.endsWith(".loop") ||
			firstArg.endsWith(".py") ||
			firstArg.endsWith(".sh") ||
			firstArg.endsWith(".ts") ||
			firstArg.endsWith(".js") ||
			firstArg.endsWith(".task");

		if (looksLikePath) {
			const resolvedPath = resolve(process.cwd(), filePath);

			// Task script: mechanical queue/prompt interface
			if (isTaskScript(resolvedPath) && existsSync(resolvedPath)) {
				const info = readScriptInfo(resolvedPath, dirname(resolvedPath), scriptParam);
				return {
					active: true,
					mode: "script",
					// Store the script path in prompt field for persistence
					prompt: resolvedPath,
					scriptParam,
					condition: info.description ?? `queue from ${basename(resolvedPath)}`,
					autoCommit: false,
				};
			}

			// Legacy .md task file
			const loopFile = parseLoopFile(filePath, process.cwd());
			if (!loopFile) return null;
			return {
				active: true,
				mode: "file",
				condition: loopFile.breakout,
				prompt: buildPrompt("file", loopFile.breakout),
				autoCommit: false,
				_firstPrompt: loopFile.task,
			} as LoopStateData & { _firstPrompt: string };
		}

		const mode = firstArg.toLowerCase();
		switch (mode) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests"), autoCommit: false };
			case "todos": {
				const tag = filteredParts.slice(1).join(" ").trim() || undefined;
				return { active: true, mode: "todos", condition: tag, prompt: buildPrompt("todos", tag), autoCommit };
			}
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self"), autoCommit: false };
			case "custom": {
				const condition = filteredParts.slice(1).join(" ").trim();
				if (!condition) return null;
				return { active: true, mode: "custom", condition, prompt: buildPrompt("custom", condition), autoCommit: false };
			}
			default:
				return null;
		}
	}

	pi.registerMessageRenderer<IterationSummary>("loop-iteration", (message, _options, theme) => {
		const d = message.details;
		if (!d) return new Text(String(message.content), 0, 0);

		const icon = d.status === "done" ? theme.fg("success", "✓")
			: d.status === "failed" ? theme.fg("error", "✗")
			: theme.fg("warning", "⏳");

		const header = `${icon} ${theme.fg("accent", theme.bold(`Iteration ${d.iteration}`))}${d.item ? ` ${theme.fg("dim", d.item)}` : ""}`;
		const lines = [header];

		for (const tc of d.toolCalls) {
			lines.push(`  ${theme.fg("muted", "→")} ${theme.fg("toolOutput", tc.preview)}`);
		}

		if (d.finalOutput && d.status !== "running") {
			const out = d.finalOutput.trim();
			const preview = out.length > 120 ? `${out.slice(0, 120)}...` : out;
			lines.push(`  ${theme.fg("dim", preview)}`);
		}

		return new Text(lines.join("\n"), 0, 0);
	});

	// -------------------------------------------------------------------------
	// Tools
	// -------------------------------------------------------------------------

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

	pi.registerTool({
		name: "loop_subagent_run",
		label: "Loop Subagent",
		description: "Run the subagent loop. Call this tool now to start processing items.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			if (!loopState.active || !loopState.subagent) {
				return {
					content: [{ type: "text", text: "No active subagent loop." }],
					details: { iterations: [], totalIterations: 0, status: "failed" as const },
				};
			}
			awaitingSubagentTrigger = false;
			subagentAbort = new AbortController();
			if (signal) signal.addEventListener("abort", () => subagentAbort?.abort(), { once: true });
			try {
				const details = await runSubagentLoop(ctx, subagentAbort.signal, onUpdate);
				const isError = details.status === "failed" || details.status === "cancelled";
				return {
					content: [{ type: "text", text: `Loop ${details.status}: ${details.totalIterations} iteration${details.totalIterations === 1 ? "" : "s"}` }],
					details,
					isError,
				};
			} finally {
				subagentAbort = null;
			}
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("loop-subagent ")) + theme.fg("accent", "running..."),
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentLoopDetails | undefined;
			if (!details || details.iterations.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const statusIcon =
				details.status === "done"      ? theme.fg("success", "✓")
				: details.status === "failed"    ? theme.fg("error",   "✗")
				: details.status === "cancelled" ? theme.fg("warning",  "⊘")
				: theme.fg("warning", "⏳");

			const lines: string[] = [];

			const hiddenCount = details.totalIterations - details.iterations.length;
			if (hiddenCount > 0) {
				lines.push(theme.fg("dim", `... ${hiddenCount} earlier iteration${hiddenCount === 1 ? "" : "s"}`));
			}

			for (const iter of details.iterations) {
				const icon =
					iter.status === "done"   ? theme.fg("success", "✓")
					: iter.status === "failed" ? theme.fg("error",   "✗")
					: theme.fg("warning", "⏳");

				const label = iter.item
					? `${theme.fg("accent", theme.bold(`Iteration ${iter.iteration}`))} ${theme.fg("dim", iter.item)}`
					: theme.fg("accent", theme.bold(`Iteration ${iter.iteration}`));
				lines.push(`${icon} ${label}`);

				const toolsToShow = expanded ? iter.toolCalls : iter.toolCalls.slice(-3);
				const hidden = iter.toolCalls.length - toolsToShow.length;
				if (hidden > 0) lines.push(`  ${theme.fg("dim", `... ${hidden} earlier`)}`);
				for (const tc of toolsToShow) {
					lines.push(`  ${theme.fg("muted", "→")} ${theme.fg("toolOutput", tc.preview)}`);
				}

				if (iter.finalOutput && iter.status !== "running") {
					const out = iter.finalOutput.trim();
					const maxLen = expanded ? 300 : 100;
					const preview = out.length > maxLen ? `${out.slice(0, maxLen)}...` : out;
					lines.push(`  ${theme.fg("dim", preview)}`);
				}
			}

			lines.push("");
			lines.push(`${statusIcon} ${theme.fg("muted", `${details.totalIterations} iteration${details.totalIterations === 1 ? "" : "s"} total`)}`);
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("loop", {
		description: "Start a follow-up loop until a breakout condition is met. Modes: tests, todos [tag], custom <condition>, self, or a .md/.loop task file.",
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop tests | todos [tag] | custom <cond> | self | <file.md>", "warning");
					return;
				}
				nextState = await showLoopSelector(ctx);
			}
			if (!nextState) { ctx.ui.notify("Loop cancelled", "info"); return; }

			if (loopState.active) {
				const ok = ctx.hasUI ? await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?") : true;
				if (!ok) { ctx.ui.notify("Loop unchanged", "info"); return; }
			}

			const stateWithExtra = nextState as LoopStateData & { _firstPrompt?: string };
			const firstPrompt = stateWithExtra._firstPrompt;
			const cleanState: LoopStateData = { ...nextState, summary: undefined, loopCount: 0 };
			delete (cleanState as any)._firstPrompt;

			setLoopState(cleanState, ctx);
			ctx.ui.notify("Loop active", "info");

			if (firstPrompt) {
				const loopCount = (loopState.loopCount ?? 0) + 1;
				loopState = { ...loopState, loopCount };
				persistState(loopState);
				updateStatus(ctx, loopState);
				pi.sendMessage({
					customType: "loop",
					content: `${firstPrompt}\n\nWhen the breakout condition is satisfied, call the signal_loop_success tool.`,
					display: true,
				}, { deliverAs: "followUp", triggerTurn: true });
			} else {
				triggerLoopPrompt(ctx);
			}

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

	pi.registerCommand("loop-subagent", {
		description: "Like /loop but spawns a fresh pi process per iteration. Accepts a task script and optional task parameter.",
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop-subagent <task.py> [param] | todos [tag] | tests | custom <cond> | self", "warning");
					return;
				}
				nextState = await showLoopSelector(ctx);
			}
			if (!nextState) { ctx.ui.notify("Loop cancelled", "info"); return; }

			if (nextState.mode === "file") {
				ctx.ui.notify("Use a task script (.py/.sh) with /loop-subagent. .md files are only supported by /loop.", "warning");
				return;
			}

			if (loopState.active) {
				const ok = ctx.hasUI ? await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?") : true;
				if (!ok) { ctx.ui.notify("Loop unchanged", "info"); return; }
			}

			const cleanState: LoopStateData = {
				...nextState,
				summary: undefined,
				loopCount: 0,
				subagent: true,
			};

			setLoopState(cleanState, ctx);
			ctx.ui.notify("Loop active (subagent mode)", "info");

			const mode = nextState.mode!;
			const condition = nextState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();

			// Ask the agent to call loop_subagent_run — gives us streaming renderResult UI.
			// before_agent_start restricts tools to only that one so the model can't do anything else.
			// If the model refuses (agent_end fires without calling it), we fall back to direct run.
			awaitingSubagentTrigger = true;
			pi.sendMessage({
				customType: "loop",
				content: "Call the loop_subagent_run tool.",
				display: false,
			}, { deliverAs: "followUp", triggerTurn: true });
		},
	});

	pi.registerCommand("loop-stop", {
		description: "Stop the active loop.",
		handler: async (_args, ctx) => {
			if (!loopState.active) { ctx.ui.notify("No active loop", "info"); return; }
			breakLoop(ctx);
		},
	});

	// -------------------------------------------------------------------------
	// Event handlers
	// -------------------------------------------------------------------------

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return;
		const apiKey = auth.apiKey;
		const instructionParts = [event.customInstructions, getCompactionInstructions(loopState.mode, loopState.condition)]
			.filter(Boolean).join("\n\n");
		try {
			const compaction = await compact(event.preparation, ctx.model, apiKey, instructionParts, event.signal);
			return { compaction };
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Loop compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = await loadState(ctx);
		updateStatus(ctx, loopState);
		if (loopState.active && loopState.mode && !loopState.summary) {
			const { mode, condition } = loopState;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		}
	}

	pi.on("session_start",  async (_event, ctx) => { await restoreLoopState(ctx); });
	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => { await restoreLoopState(ctx); });



	let justCommitted = false;

	pi.on("tool_result", async (event, ctx) => {
		if (!loopState.active || !loopState.autoCommit) return;
		if (event.toolName !== "todo") return;

		const input = event.input as { action?: string; id?: string; status?: string; title?: string };
		const isClosed = (input.action === "update" && input.status === "closed") || input.action === "delete";
		if (!isClosed || event.isError || !input.id) return;

		const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
		if (statusResult.code !== 0 || !statusResult.stdout.trim()) return;

		const commitInstruction = input.title
			? `/skill:commit ${input.title}`
			: `/skill:commit Complete todo ${input.id}`;
		justCommitted = true;
		pi.sendUserMessage(commitInstruction, { deliverAs: "followUp" });
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm("Break active loop?", "Operation aborted. Break out of the loop?");
			if (confirm) { breakLoop(ctx); return; }
		}

		if (justCommitted) { justCommitted = false; return; }

		// Fallback: if the trigger turn ended without calling loop_subagent_run
		// (model refused or doesn't support tools), run the loop directly.
		if (awaitingSubagentTrigger && loopState.subagent) {
			awaitingSubagentTrigger = false;
			ctx.ui.notify("Model didn't call loop tool — running directly", "info");
			subagentAbort = new AbortController();
			void runSubagentLoop(ctx, subagentAbort.signal).finally(() => { subagentAbort = null; });
			return;
		}

		triggerLoopPrompt(ctx);
	});
}
