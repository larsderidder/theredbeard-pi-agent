import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: registerRecap, buildRecapTranscript, readRecapParkingLot } = await jiti.import("../extensions/recap.ts");
initTheme("dark", false);

function message(role, content, extra = {}) {
	return { type: "message", message: { role, content, ...extra } };
}

const entries = [
	message("user", "Fix the login bug"),
	message("assistant", [
		{ type: "thinking", thinking: "Private reasoning" },
		{ type: "text", text: "Investigating" },
		{ type: "toolCall", name: "edit", arguments: { path: "/app/login.ts" } },
	]),
	message("toolResult", [{ type: "text", text: "Permission denied" }], { toolName: "edit", isError: true }),
	{ type: "compaction", summary: "Earlier: reproduced the issue" },
	{ type: "branch_summary", summary: "Other branch: ruled out cookies" },
	message("bashExecution", undefined, { command: "npm test", output: "Tests passed", exitCode: 0 }),
	message("user", [{ type: "image", data: "IMAGE_DATA" }, { type: "text", text: "Look at this" }]),
	{ type: "custom", customType: "unrelated-state", data: { secret: "DO_NOT_INCLUDE" } },
];

{
	const transcript = buildRecapTranscript(entries);
	assert.match(transcript.text, /Fix the login bug/);
	assert.match(transcript.text, /Investigating/);
	assert.match(transcript.text, /edit.*login.ts/);
	assert.match(transcript.text, /ERROR.*Permission denied/);
	assert.match(transcript.text, /Earlier: reproduced/);
	assert.match(transcript.text, /Other branch: ruled out/);
	assert.match(transcript.text, /npm test.*exit 0/s);
	assert.match(transcript.text, /Tests passed/);
	assert.match(transcript.text, /Look at this/);
	assert.doesNotMatch(transcript.text, /Private reasoning|IMAGE_DATA|DO_NOT_INCLUDE/);
	assert.equal(transcript.truncated, false);
	assert.equal(buildRecapTranscript([]).text, "");
}

{
	const large = [message("user", "Original goal"), ...Array.from({ length: 100 }, () => message("assistant", "x".repeat(2000))), message("user", "Current question")];
	const transcript = buildRecapTranscript(large, 8000);
	assert.ok(transcript.text.length <= 8000);
	assert.equal(transcript.truncated, true);
	assert.match(transcript.text, /Original goal/);
	assert.match(transcript.text, /Current question/);
	assert.match(transcript.text, /omitted/);
	const longMessage = buildRecapTranscript([message("user", `Start${"x".repeat(10000)}End`)]);
	assert.equal(longMessage.truncated, true);
	assert.match(longMessage.text, /Start/);
	assert.match(longMessage.text, /End/);
}

function harness(response = { stopReason: "stop", content: [{ type: "text", text: "## Goal\nFix login\n\n## Done\nReproduced\n\n## Current state\nEdit failed" }] }) {
	const commands = new Map();
	const events = new Map();
	registerRecap({
		registerCommand(name, definition) { commands.set(name, definition); },
		on(name, handler) { events.set(name, handler); },
	});
	const calls = [];
	const notices = [];
	const panels = [];
	let resolveStarted;
	const started = new Promise((resolve) => { resolveStarted = resolve; });
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	let cancel = false;
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		model: { id: "test-model", provider: "test-provider", contextWindow: 128000, maxTokens: 4096 },
		sessionManager: {
			getBranch: () => structuredClone(entries),
			getSessionId: () => "session-a",
		},
		modelRegistry: {
			hasConfiguredAuth: () => true,
			async complete(model, context, options) {
				calls.push({ model, context, options });
				resolveStarted();
				return response;
			},
		},
		ui: {
			notify(text, level) { notices.push({ text, level }); },
			custom(factory) {
				return new Promise((resolve) => {
					let component;
					const done = (value) => {
						component?.dispose?.();
						resolve(value);
					};
					component = factory(tui, theme, {}, done);
					panels.push(component);
					if (panels.length === 1) {
						if (cancel) {
							component.handleInput("\u001b");
						}
					} else {
						for (const width of [20, 40, 80]) {
							const lines = component.render(width);
							assert.ok(lines.length <= tui.terminal.rows);
							assert.ok(lines.every((line) => visibleWidth(line) <= width));
						}
						component.handleInput("\r");
					}
				});
			},
		},
	};
	return { commands, events, ctx, calls, notices, panels, started, setCancel: () => { cancel = true; } };
}

{
	const h = harness();
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls.length, 1);
	const { model, context, options } = h.calls[0];
	assert.equal(model, h.ctx.model);
	assert.equal(context.messages.length, 1);
	assert.equal(context.messages[0].role, "user");
	assert.equal(context.tools, undefined);
	assert.match(context.systemPrompt, /untrusted/i);
	assert.match(context.systemPrompt, /Current state/);
	assert.match(context.systemPrompt, /## Pending issues/);
	assert.match(context.systemPrompt, /never parked/);
	assert.match(context.systemPrompt, /dismissed/);
	assert.equal(options.maxTokens, 2048);
	assert.ok(options.sessionId);
	assert.notEqual(options.sessionId, "session-a");
	assert.equal(h.panels.length, 2);
	assert.deepEqual(h.notices, []);
	assert.equal(options.reasoningEffort, undefined);
}

{
	const h = harness();
	h.setCancel();
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.panels.length, 1);
	assert.equal(h.calls.length, 0);
}

for (const stopReason of ["error", "length", "toolUse"]) {
	const h = harness({ stopReason, errorMessage: "test failure", content: [{ type: "text", text: "Incomplete" }] });
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.panels.length, 1);
	assert.equal(h.notices.at(-1).level, "error");
	if (stopReason === "error") {
		assert.match(h.notices.at(-1).text, /test failure/);
		assert.match(h.notices.at(-1).text, /test-provider\/test-model/);
	}
}

{
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.at(-1).level, "warning");
}

{
	const h = harness();
	h.ctx.sessionManager.getBranch = () => [];
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls.length, 0);
}

{
	const h = harness();
	const mainController = new AbortController();
	h.ctx.signal = mainController.signal;
	h.ctx.abort = () => { throw new Error("Must not abort the main agent"); };
	h.ctx.waitForIdle = () => { throw new Error("Must not wait for the main agent"); };
	h.ctx.isIdle = () => false;
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(mainController.signal.aborted, false);
	assert.match(h.calls[0].context.messages[0].content, /Main agent is running/);
}

{
	let resolveResponse;
	const h = harness(new Promise((resolve) => { resolveResponse = resolve; }));
	const pending = h.commands.get("recap").handler("", h.ctx);
	await h.started;
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls.length, 1);
	assert.match(h.notices.at(-1).text, /already open/);
	h.events.get("session_shutdown")();
	await pending;
	assert.equal(h.calls[0].options.signal.aborted, true);
	resolveResponse({ stopReason: "stop", content: [{ type: "text", text: "Late result" }] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.panels.length, 1);
}

{
	const h = harness();
	h.ctx.modelRegistry.complete = async () => { throw new Error("Provider failure"); };
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).text, /Provider failure/);
}

{
	const h = harness({ stopReason: "stop", content: [] });
	await h.commands.get("recap").handler("", h.ctx);
	assert.match(h.notices.at(-1).text, /empty recap/);
}

{
	const h = harness({ stopReason: "stop", content: [{ type: "text", text: Array.from({ length: 80 }, (_, index) => `Line ${index} with unicode: 漢字 🦊`).join("\n") }] });
	await h.commands.get("recap").handler("", h.ctx);
	const panel = h.panels[1];
	const before = panel.render(40);
	panel.handleInput("\u001b[B");
	assert.notDeepEqual(panel.render(40), before);
	panel.handleInput("\u001b[A");
	assert.deepEqual(panel.render(40), before);
	panel.invalidate();
	assert.deepEqual(panel.render(40), before);
}

{
	const h = harness();
	h.ctx.model.reasoning = true;
	h.ctx.model.thinkingLevelMap = { off: null, minimal: null, low: "low" };
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls[0].options.reasoningEffort, "low");
}

{
	const h = harness();
	h.ctx.model.reasoning = true;
	h.ctx.model.thinkingLevelMap = { minimal: "minimal" };
	await h.commands.get("recap").handler("", h.ctx);
	assert.equal(h.calls[0].options.reasoningEffort, "minimal");
}

{
	const h = harness({ stopReason: "error", errorMessage: "\u001b[31mUnsupported reasoning effort\u001b[0m" });
	await h.commands.get("recap").handler("", h.ctx);
	assert.match(h.notices.at(-1).text, /Unsupported reasoning effort/);
	assert.ok(!h.notices.at(-1).text.includes("\u001b"));
}

{
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-recap-parking-"));
	const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		assert.equal((await readRecapParkingLot("session-a", directory)).text, "");
		await fs.mkdir(path.join(directory, "parking"));
		const filePath = path.join(directory, "parking", "session-a.json");
		const data = {
			version: 1, sessionId: "session-a", nextId: 4,
			items: [
				{ id: 1, title: "Suspended design discussion", context: "Choose the auth design", status: "parked" },
				{ id: 2, title: "Old failure", context: "Was fixed", status: "dismissed" },
				{ id: 3, title: "Resumed investigation", context: "Still needs verification", status: "resumed" },
			],
		};
		await fs.writeFile(filePath, JSON.stringify(data));
		const before = await fs.readFile(filePath, "utf8");
		const parking = await readRecapParkingLot("session-a", directory);
		assert.match(parking.text, /#1 \[parked\].*Suspended design discussion/);
		assert.match(parking.text, /Choose the auth design/);
		assert.match(parking.text, /#2 \[dismissed\]/);
		assert.match(parking.text, /#3 \[resumed\]/);
		assert.equal(parking.truncated, false);
		const limited = await readRecapParkingLot("session-a", directory, 100);
		assert.ok(limited.text.length <= 100);
		assert.equal(limited.truncated, true);
		const h = harness();
		await h.commands.get("recap").handler("", h.ctx);
		assert.match(h.calls[0].context.messages[0].content, /Suspended design discussion/);
		assert.match(h.calls[0].context.messages[0].content, /Fix the login bug/);
		assert.equal(await fs.readFile(filePath, "utf8"), before);
		assert.equal((await readRecapParkingLot("another-session", directory)).text, "");
		await fs.writeFile(filePath, "not JSON");
		assert.match((await readRecapParkingLot("session-a", directory)).text, /unavailable/);
		const fallback = harness();
		await fallback.commands.get("recap").handler("", fallback.ctx);
		assert.equal(fallback.calls.length, 1);
		assert.match(fallback.calls[0].context.messages[0].content, /unavailable/);
		assert.match((await readRecapParkingLot("../escape", directory)).text, /unavailable/);
	} finally {
		if (originalAgentDirectory === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
		}
		await fs.rm(directory, { recursive: true, force: true });
	}
}

console.log("recap tests passed");
