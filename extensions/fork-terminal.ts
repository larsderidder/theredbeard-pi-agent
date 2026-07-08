import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function commandExists(command: string): boolean {
	if (command.includes("/")) return existsSync(command);

	const pathValue = process.env.PATH ?? "";
	return pathValue.split(path.delimiter).some((dir) => existsSync(`${dir}/${command}`));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function entryText(entry: SessionEntry): string {
	if (entry.type !== "message" || !("content" in entry.message)) return "";

	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part: any) => (part?.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function renderCommandTemplate(template: string, cwd: string, args: string[]): string {
	return template
		.split("{cwd}")
		.join(shellQuote(cwd))
		.split("{args}")
		.join(args.map(shellQuote).join(" "))
		.split("{pi}")
		.join(shellQuote("pi"));
}

function launchWithTerminal(terminal: string, cwd: string, args: string[]): string | undefined {
	switch (terminal) {
		case "kitty":
			if (!commandExists("kitty")) return undefined;
			spawn("kitty", ["--directory", cwd, "pi", ...args], { detached: true, stdio: "ignore" }).unref();
			return "kitty";
		case "ghostty":
			if (!commandExists("ghostty")) return undefined;
			spawn("ghostty", ["--working-directory", cwd, "-e", "pi", ...args], { detached: true, stdio: "ignore" }).unref();
			return "ghostty";
		case "wezterm":
			if (!commandExists("wezterm")) return undefined;
			spawn("wezterm", ["start", "--cwd", cwd, "--", "pi", ...args], { detached: true, stdio: "ignore" }).unref();
			return "wezterm";
		case "tmux":
			if (!process.env.TMUX || !commandExists("tmux")) return undefined;
			spawn("tmux", ["new-window", "-c", cwd, ["pi", ...args].map(shellQuote).join(" ")], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return "tmux new-window";
		case "gnome-terminal": {
			if (!commandExists("gnome-terminal")) return undefined;
			const command = `cd ${shellQuote(cwd)} && pi ${args.map(shellQuote).join(" ")}; exec bash`;
			spawn("gnome-terminal", ["--", "bash", "-lc", command], { detached: true, stdio: "ignore" }).unref();
			return "gnome-terminal";
		}
		case "xfce4-terminal": {
			if (!commandExists("xfce4-terminal")) return undefined;
			const command = `cd ${shellQuote(cwd)} && pi ${args.map(shellQuote).join(" ")}; exec bash`;
			spawn("xfce4-terminal", ["--command", `bash -lc ${shellQuote(command)}`], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return "xfce4-terminal";
		}
		default:
			return undefined;
	}
}

function getSessionManager(): any {
	const { SessionManager } = require("@earendil-works/pi-coding-agent");
	return SessionManager;
}

function launchPi(cwd: string, args: string[]): string {
	const commandTemplate = process.env.PI_FORK_COMMAND?.trim();
	if (commandTemplate) {
		spawn("sh", ["-lc", renderCommandTemplate(commandTemplate, cwd, args)], {
			cwd,
			detached: true,
			stdio: "ignore",
		}).unref();
		return "PI_FORK_COMMAND";
	}

	const preferredTerminal = process.env.PI_FORK_TERMINAL?.trim();
	if (preferredTerminal) {
		const launched = launchWithTerminal(preferredTerminal, cwd, args);
		if (!launched) throw new Error(`Configured terminal is unavailable: ${preferredTerminal}`);
		return launched;
	}

	for (const terminal of ["kitty", "ghostty", "wezterm", "tmux", "gnome-terminal", "xfce4-terminal"]) {
		const launched = launchWithTerminal(terminal, cwd, args);
		if (launched) return launched;
	}

	throw new Error("No supported terminal found. Set PI_FORK_TERMINAL or PI_FORK_COMMAND.");
}

function createBranchSession(ctx: any, leafId: string): string {
	const sourceFile = ctx.sessionManager.getSessionFile();
	if (!sourceFile) throw new Error("Current session is not persisted yet");

	const copy = getSessionManager().open(sourceFile, ctx.sessionManager.getSessionDir());
	const sessionPath = copy.createBranchedSession(leafId);
	if (!sessionPath) throw new Error("Could not create forked session file");

	return sessionPath;
}

function resolveLaunchDirectory(baseCwd: string, cwd: string): string {
	const resolved = path.resolve(baseCwd, cwd.trim());
	if (!existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
	if (!statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	return resolved;
}

function createEmptySessionPath(ctx: any, cwd: string = ctx.cwd): string {
	const session = getSessionManager().create(cwd, ctx.sessionManager.getSessionDir());
	const sessionPath = session.getSessionFile();
	if (!sessionPath) throw new Error("Could not create empty session path");
	return sessionPath;
}

function launchPiSession(cwd: string, sessionPath: string, initialPrompt?: string, sessionName?: string): string {
	const args = [] as string[];
	if (sessionName?.trim()) {
		args.push("--name", sessionName.trim());
	}
	args.push("--session", sessionPath);
	if (initialPrompt?.trim()) args.push(initialPrompt.trim());
	return launchPi(cwd, args);
}

function launchFork(ctx: any, leafId: string | null, initialPrompt?: string, sessionName?: string): string {
	const sessionPath = leafId ? createBranchSession(ctx, leafId) : createEmptySessionPath(ctx);
	return launchPiSession(ctx.cwd, sessionPath, initialPrompt, sessionName);
}

function buildLoopSubagentPrompt(taskScript: string, taskParam?: string): string {
	const parts = [shellQuote(taskScript)];
	if (taskParam?.trim()) parts.push(shellQuote(taskParam.trim()));
	return `/loop-subagent ${parts.join(" ")}`;
}

const MAX_BTW_PROMPT_LENGTH = 100_000;

function normalizeBtwPrompt(input: string): string | undefined {
	const prompt = input.trim();
	if (!prompt) return undefined;

	// ASVS 2.2.1: bound user supplied prompt before passing it to the child process boundary.
	if (prompt.length > MAX_BTW_PROMPT_LENGTH) {
		throw new Error(`btw prompt is too long (${prompt.length} chars, max ${MAX_BTW_PROMPT_LENGTH})`);
	}

	return prompt;
}

function splitQuotedArgs(input: string): string[] {
	const parts: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(input)) !== null) {
		parts.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return parts;
}

function launchLoopTerminal(ctx: any, cwd: string, taskScript: string, taskParam?: string, sessionName?: string): string {
	const sessionPath = createEmptySessionPath(ctx, cwd);
	return launchPiSession(cwd, sessionPath, buildLoopSubagentPrompt(taskScript, taskParam), sessionName);
}

let activeConfirmedClone: string | undefined;
let activeConfirmedLoop: string | undefined;

function findAssistantBeforeLastUserMessageId(ctx: any): string | null {
	const branch: SessionEntry[] = ctx.sessionManager.getBranch();
	let latestUserIndex = -1;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			latestUserIndex = i;
			break;
		}
	}

	const startIndex = latestUserIndex >= 0 ? latestUserIndex - 1 : branch.length - 1;
	for (let i = startIndex; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") return entry.id;
	}
	return null;
}

function buildForkChoices(ctx: any): Array<{ label: string; leafId: string | null }> {
	const branch: SessionEntry[] = ctx.sessionManager.getBranch();
	const leafId = ctx.sessionManager.getLeafId();
	const choices: Array<{ label: string; leafId: string | null }> = [];

	const hasAgentMessage = branch.some((entry: SessionEntry) => entry.type === "message" && entry.message.role === "assistant");
	if (leafId && hasAgentMessage) {
		choices.push({ label: "Current state (after latest agent message)", leafId });
	}

	const userEntries = branch.filter((entry: SessionEntry) => entry.type === "message" && entry.message.role === "user").reverse();

	for (const entry of userEntries) {
		const text = oneLine(entryText(entry));
		choices.push({
			label: `Before: ${text.slice(0, 120) || "(empty message)"}`,
			leafId: entry.parentId ?? null,
		});
	}

	return choices;
}

export default function forkTerminalExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "clone-terminal",
		label: "Clone Terminal",
		description: "Open a cloned pi session in a new terminal",
		promptSnippet: "Clone the current pi session into a new terminal",
		promptGuidelines: [
			"Use clone-terminal only when the user explicitly asks to open a cloned terminal or separate session.",
			"Use clone-terminal only after the user has explicitly granted permission to open a new terminal.",
			"Use clone-terminal with allowLaunch=true.",
		],
		parameters: Type.Object({
			allowLaunch: Type.Optional(Type.Boolean({ description: "Permit launching a new terminal after confirmation. Use only when the user explicitly requested a cloned session." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const cloneParams = params as unknown as { allowLaunch?: boolean };
			if (!cloneParams.allowLaunch) {
				return {
					content: [{ type: "text", text: "Blocked: clone-terminal requires allowLaunch=true." }],
					details: { blocked: true, reason: "allowLaunch=false" },
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Blocked: confirmation required but no UI is available." }],
					details: { blocked: true, reason: "no-ui" },
					isError: true,
				};
			}

			if (activeConfirmedClone) {
				return {
					content: [{ type: "text", text: `Blocked: another clone confirmation is already active: ${activeConfirmedClone}.` }],
					details: { blocked: true, reason: "active-confirmation", activeCommand: activeConfirmedClone },
					isError: true,
				};
			}

			activeConfirmedClone = "clone-terminal";
			onUpdate?.({ content: [{ type: "text", text: "Waiting for confirmation to open a cloned terminal." }], details: {} });
			try {
				const ok = await ctx.ui.confirm("clone-terminal", "Open a new terminal and clone the current pi session?");
				if (!ok) {
					return {
						content: [{ type: "text", text: "Blocked by user." }],
						details: { blocked: true, reason: "blocked-by-user" },
					};
				}
			} finally {
				activeConfirmedClone = undefined;
			}

			const terminal = launchFork(ctx, ctx.sessionManager.getLeafId() ?? null);
			return {
				content: [{ type: "text", text: `Opened clone in ${terminal}` }],
				details: { terminal },
			};
		},
	});

	pi.registerCommand("fork-terminal", {
		description: "Fork before a previous user message or from the current state in a new terminal",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const choices = buildForkChoices(ctx);
			if (choices.length === 0) {
				ctx.ui.notify("No session state to fork from", "info");
				return;
			}

			const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
			const selected = await ctx.ui.select("Fork in new terminal", labels);
			if (!selected) return;

			const index = labels.indexOf(selected);
			const terminal = launchFork(ctx, choices[index].leafId);
			ctx.ui.notify(`Opened fork in ${terminal}`, "info");
		},
	});

	pi.registerCommand("clone-terminal", {
		description: "Clone the current branch in a new terminal",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				const terminal = launchFork(ctx, null);
				ctx.ui.notify(`Opened new pi session in ${terminal}`, "info");
				return;
			}

			const terminal = launchFork(ctx, leafId);
			ctx.ui.notify(`Opened clone in ${terminal}`, "info");
		},
	});

	pi.registerCommand("btw", {
		description: "Clone from the last assistant message in a new terminal and optionally submit a prompt",
		handler: async (args, ctx) => {
			let prompt: string | undefined;
			try {
				prompt = normalizeBtwPrompt(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const leafId = findAssistantBeforeLastUserMessageId(ctx);
			const sessionName = prompt ? `btw: ${oneLine(prompt).slice(0, 80)}` : undefined;
			const terminal = launchFork(ctx, leafId, prompt, sessionName);
			const message = prompt
				? `Opened clone in ${terminal} and submitted prompt`
				: `Opened clone in ${terminal}`;
			ctx.ui.notify(message, "info");
		},
	});

	pi.registerTool({
		name: "loop-terminal",
		label: "Loop Terminal",
		description: "Open a fresh pi session in a chosen directory and start /loop-subagent",
		promptSnippet: "Start a fresh pi session in a directory and launch /loop-subagent",
		promptGuidelines: [
			"Use loop-terminal only when the user explicitly asks for a fresh visible pi session for a loop worker.",
			"Use loop-terminal only after the user has explicitly granted permission to open a new terminal.",
			"Use loop-terminal with allowLaunch=true, and provide cwd and taskScript. Use taskParam only for the optional loop subagent parameter.",
		],
		parameters: Type.Object({
			allowLaunch: Type.Optional(Type.Boolean({ description: "Permit launching a new terminal after confirmation. Use only when the user explicitly requested a loop worker session." })),
			cwd: Type.String({ description: "Directory where the new pi session should start." }),
			taskScript: Type.String({ description: "Task script passed to /loop-subagent, for example loop_task.py." }),
			taskParam: Type.Optional(Type.String({ description: "Optional parameter forwarded to /loop-subagent." })),
			sessionName: Type.Optional(Type.String({ description: "Optional visible terminal and session name." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const loopParams = params as unknown as {
				allowLaunch?: boolean;
				cwd?: string;
				taskScript?: string;
				taskParam?: string;
				sessionName?: string;
			};

			if (!loopParams.allowLaunch) {
				return {
					content: [{ type: "text", text: "Blocked: loop-terminal requires allowLaunch=true." }],
					details: { blocked: true, reason: "allowLaunch=false" },
					isError: true,
				};
			}

			if (!loopParams.cwd?.trim()) {
				return {
					content: [{ type: "text", text: "Blocked: loop-terminal requires cwd." }],
					details: { blocked: true, reason: "missing-cwd" },
					isError: true,
				};
			}

			if (!loopParams.taskScript?.trim()) {
				return {
					content: [{ type: "text", text: "Blocked: loop-terminal requires taskScript." }],
					details: { blocked: true, reason: "missing-taskScript" },
					isError: true,
				};
			}

			const launchCwd = resolveLaunchDirectory(ctx.cwd, loopParams.cwd);
			const scriptPath = path.resolve(launchCwd, loopParams.taskScript.trim());
			if (!existsSync(scriptPath)) {
				return {
					content: [{ type: "text", text: `Blocked: task script does not exist: ${scriptPath}` }],
					details: { blocked: true, reason: "missing-taskScript", taskScript: scriptPath },
					isError: true,
				};
			}
			if (!statSync(scriptPath).isFile()) {
				return {
					content: [{ type: "text", text: `Blocked: task script is not a file: ${scriptPath}` }],
					details: { blocked: true, reason: "taskScript-not-file", taskScript: scriptPath },
					isError: true,
				};
			}

			const sessionName = loopParams.sessionName?.trim() || `loop ${path.basename(scriptPath)}`;
			const prompt = buildLoopSubagentPrompt(scriptPath, loopParams.taskParam);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Blocked: confirmation required but no UI is available." }],
					details: { blocked: true, reason: "no-ui" },
					isError: true,
				};
			}

			if (activeConfirmedLoop) {
				return {
					content: [{ type: "text", text: `Blocked: another loop confirmation is already active: ${activeConfirmedLoop}.` }],
					details: { blocked: true, reason: "active-confirmation", activeCommand: activeConfirmedLoop },
					isError: true,
				};
			}

			activeConfirmedLoop = `${sessionName} @ ${launchCwd}`;
			onUpdate?.({ content: [{ type: "text", text: "Waiting for confirmation to open a loop terminal." }], details: {} });
			try {
				const ok = await ctx.ui.confirm(
					"loop-terminal",
					`Open a new terminal in ${launchCwd} and start ${prompt}?`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Blocked by user." }],
						details: { blocked: true, reason: "blocked-by-user" },
					};
				}
			} finally {
				activeConfirmedLoop = undefined;
			}

			const terminal = launchLoopTerminal(ctx, launchCwd, scriptPath, loopParams.taskParam, sessionName);
			return {
				content: [{ type: "text", text: `Opened loop terminal in ${terminal}` }],
				details: {
					terminal,
					cwd: launchCwd,
					taskScript: scriptPath,
					taskParam: loopParams.taskParam?.trim() || undefined,
					sessionName,
				},
			};
		},
	});

	pi.registerCommand("loop-terminal", {
		description: "Start a fresh pi session in a directory and launch /loop-subagent",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const parts = splitQuotedArgs(args.trim());
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /loop-terminal <cwd> <task.py> [param]", "error");
				return;
			}

			const [cwdArg, taskScript, ...taskParamParts] = parts;
			const taskParam = taskParamParts.join(" ").trim() || undefined;

			let launchCwd: string;
			let scriptPath: string;
			try {
				launchCwd = resolveLaunchDirectory(ctx.cwd, cwdArg);
				scriptPath = path.resolve(launchCwd, taskScript);
				if (!existsSync(scriptPath)) {
					ctx.ui.notify(`Task script does not exist: ${scriptPath}`, "error");
					return;
				}
				if (!statSync(scriptPath).isFile()) {
					ctx.ui.notify(`Task script is not a file: ${scriptPath}`, "error");
					return;
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const sessionName = `loop ${path.basename(scriptPath)}`;
			const terminal = launchLoopTerminal(ctx, launchCwd, scriptPath, taskParam, sessionName);
			ctx.ui.notify(`Opened loop terminal in ${terminal}`, "info");
		},
	});
}
