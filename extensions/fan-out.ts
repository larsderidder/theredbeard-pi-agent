/**
 * /fan-out command - dispatch open todos to worker subagents.
 *
 * The extension reads todos and spawns pi processes directly.
 * No LLM involvement in the dispatch itself.
 *
 * Usage:
 *   /fan-out                          - dispatch all open todos in parallel
 *   /fan-out --sequential             - dispatch one at a time (avoids rate limits)
 *   /fan-out --tag mytag              - only todos with a specific tag
 *   /fan-out --model opencode/kimi-k2.5-free
 *   /fan-out --tag mytag --model opencode/kimi-k2.5-free --sequential
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
const BASE_AGENT = path.join(AGENT_DIR, "todo-worker.md");
const TODO_DIR_NAME = ".pi/todos";

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	assigned_to_session?: string;
}

function parseArgs(args: string): { tag?: string; model?: string; sequential: boolean } {
	const result: { tag?: string; model?: string; sequential: boolean } = { sequential: false };
	const parts = args.trim().split(/\s+/);
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--tag" && parts[i + 1]) result.tag = parts[++i];
		else if (parts[i] === "--model" && parts[i + 1]) result.model = parts[++i];
		else if (parts[i] === "--sequential") result.sequential = true;
	}
	return result;
}

function rewriteModel(content: string, model: string): string {
	if (/^model:.*$/m.test(content)) return content.replace(/^model:.*$/m, `model: ${model}`);
	return content.replace(/^---\n/, `---\nmodel: ${model}\n`);
}

function spawnPi(piArgs: string[]): Promise<{ exitCode: number; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("pi", piArgs, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", (d) => { stderr += d.toString(); });
		proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
		proc.on("error", (err) => resolve({ exitCode: 1, stderr: err.message }));
	});
}

async function testModel(model: string): Promise<{ ok: boolean; error?: string }> {
	const { exitCode, stderr } = await spawnPi([
		"--mode", "json", "-p", "--no-session", "--model", model, "ping",
	]);
	if (exitCode === 0) return { ok: true };
	const msg = stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${exitCode}`;
	return { ok: false, error: msg };
}

async function readOpenTodos(cwd: string): Promise<TodoFrontMatter[]> {
	const todoDir = path.resolve(cwd, TODO_DIR_NAME);
	let entries: string[] = [];
	try { entries = await fsp.readdir(todoDir); } catch { return []; }

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		try {
			const content = await fsp.readFile(path.join(todoDir, entry), "utf8");
			const match = content.match(/^\{[\s\S]*?\}/);
			if (!match) continue;
			const fm = JSON.parse(match[0]) as Partial<TodoFrontMatter>;
			const status = fm.status ?? "open";
			if (["closed", "done"].includes(status.toLowerCase())) continue;
			if (fm.assigned_to_session) continue;
			todos.push({ id: fm.id ?? id, title: fm.title ?? "", tags: fm.tags ?? [], status });
		} catch { /* skip unreadable */ }
	}
	return todos;
}

function buildPiArgs(todo: TodoFrontMatter, model: string | undefined, systemPrompt: string | null, tmpDir: string): { args: string[]; tmpFile: string | null } {
	const piArgs = ["--mode", "json", "-p", "--no-session"];
	if (model) piArgs.push("--model", model);

	let tmpFile: string | null = null;
	if (systemPrompt) {
		tmpFile = path.join(tmpDir, `prompt-${todo.id}.md`);
		fs.writeFileSync(tmpFile, systemPrompt, { encoding: "utf8", mode: 0o600 });
		piArgs.push("--append-system-prompt", tmpFile);
	}

	piArgs.push(`Work on todo TODO-${todo.id}: "${todo.title}". Claim it first, do the work, then mark it done.`);
	return { args: piArgs, tmpFile };
}

function cleanup(tmpFile: string | null) {
	if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
}

export default function fanOutExtension(pi: ExtensionAPI) {
	pi.registerCommand("fan-out", {
		description:
			"Dispatch open todos to worker subagents. " +
			"Options: --tag <tag> filter by tag, --model <model> override worker model, --sequential run one at a time.",
		handler: async (args, ctx) => {
			const { tag, model, sequential } = parseArgs(args ?? "");

			// Validate model
			if (model) {
				ctx.ui.notify(`Testing model ${model}...`, "info");
				const test = await testModel(model);
				if (!test.ok) {
					ctx.ui.notify(`Model "${model}" failed: ${test.error}`, "error");
					return;
				}
				ctx.ui.notify(`Model ${model} OK`, "info");
			}

			// Write temp agent file if model override requested
			let tempAgentPath: string | null = null;
			if (model) {
				try {
					const base = fs.readFileSync(BASE_AGENT, "utf8");
					const safeName = model.replace(/[^a-z0-9-]/gi, "-");
					const agentName = `todo-worker-${safeName}`;
					tempAgentPath = path.join(AGENT_DIR, `${agentName}.md`);
					const rewritten = rewriteModel(base, model).replace(/^name:.*$/m, `name: ${agentName}`);
					fs.writeFileSync(tempAgentPath, rewritten, "utf8");
					setTimeout(() => { try { if (tempAgentPath) fs.unlinkSync(tempAgentPath); } catch { /* ignore */ } }, 30 * 60 * 1000);
				} catch (err: any) {
					ctx.ui.notify(`Warning: could not write temp agent: ${err.message}`, "warning");
				}
			}

			// Read system prompt from agent file
			let systemPrompt: string | null = null;
			try {
				const agentContent = fs.readFileSync(BASE_AGENT, "utf8");
				const body = agentContent.replace(/^---[\s\S]*?---\n/, "").trim();
				if (body) systemPrompt = body;
			} catch { /* no system prompt */ }

			// Read and filter todos
			const all = await readOpenTodos(ctx.cwd);
			const todos = tag ? all.filter((t) => t.tags.includes(tag)) : all;

			if (todos.length === 0) {
				ctx.ui.notify(tag ? `No open todos with tag "${tag}"` : "No open todos", "info");
				return;
			}

			const tmpDir = os.tmpdir();
			ctx.ui.notify(`Dispatching ${todos.length} todo(s) ${sequential ? "sequentially" : "in parallel"}...`, "info");

			if (sequential) {
				for (let i = 0; i < todos.length; i++) {
					const todo = todos[i];
					ctx.ui.notify(`[${i + 1}/${todos.length}] Starting: ${todo.title}`, "info");
					const { args: piArgs, tmpFile } = buildPiArgs(todo, model, systemPrompt, tmpDir);
					const { exitCode, stderr } = await spawnPi(piArgs);
					cleanup(tmpFile);
					if (exitCode !== 0) {
						ctx.ui.notify(`[${i + 1}/${todos.length}] Failed: ${todo.title} — ${stderr.trim().split("\n").pop() ?? "unknown error"}`, "error");
					} else {
						ctx.ui.notify(`[${i + 1}/${todos.length}] Done: ${todo.title}`, "info");
					}
				}
			} else {
				const results = await Promise.all(todos.map(async (todo, i) => {
					const { args: piArgs, tmpFile } = buildPiArgs(todo, model, systemPrompt, tmpDir);
					const { exitCode, stderr } = await spawnPi(piArgs);
					cleanup(tmpFile);
					return { todo, exitCode, stderr };
				}));

				const failed = results.filter((r) => r.exitCode !== 0);
				const done = results.filter((r) => r.exitCode === 0);
				ctx.ui.notify(`Done: ${done.length} succeeded, ${failed.length} failed`, failed.length > 0 ? "error" : "info");
				for (const r of failed) {
					ctx.ui.notify(`Failed: ${r.todo.title} — ${r.stderr.trim().split("\n").pop() ?? "unknown error"}`, "error");
				}
			}

			ctx.ui.notify("Fan-out complete", "info");
		},
	});
}
