import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const forkTerminalModule = await jiti.import("../extensions/fork-terminal.ts");

function registerExtension() {
	const commands = new Map();
	const handlers = new Map();
	const appendedEntries = [];
	const sentMessages = [];
	const modelChanges = [];
	const thinkingChanges = [];
	let thinkingLevel = "high";

	const pi = {
		appendEntry(customType, data) {
			appendedEntries.push({ customType, data });
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerTool() {},
		sendUserMessage(message) {
			sentMessages.push(message);
		},
		async setModel(model) {
			modelChanges.push(model);
			return true;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
			thinkingChanges.push(level);
		},
	};

	forkTerminalModule.default(pi);
	return {
		appendedEntries,
		commands,
		handlers,
		modelChanges,
		sentMessages,
		thinkingChanges,
	};
}

function createContext(tokens, compactCalls) {
	const originalModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const compactModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
	return {
		ctx: {
			compact(options) {
				compactCalls.push(options);
			},
			getContextUsage() {
				return { tokens, contextWindow: 400_000, percent: tokens / 4_000 };
			},
			model: originalModel,
			modelRegistry: {
				find(provider, id) {
					if (provider === compactModel.provider && id === compactModel.id) {
						return compactModel;
					}
					return undefined;
				},
			},
			sessionManager: {
				getBranch() {
					return [{
						type: "custom",
						id: "btw2-task-1",
						customType: "btw2-task",
						data: { task: "Investigate the deployment" },
					}];
				},
			},
			ui: { notify() {} },
		},
		compactModel,
		originalModel,
	};
}

async function flushDeferredBtw2Start() {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

{
	const extension = registerExtension();
	assert.equal(extension.commands.has("btw"), false);
	assert.ok(extension.commands.has("btw2"));
	assert.ok(extension.handlers.has("session_start"));

	const compactCalls = [];
	const { ctx } = createContext(79_999, compactCalls);
	extension.handlers.get("session_start")({}, ctx);
	assert.deepEqual(extension.sentMessages, []);
	await flushDeferredBtw2Start();

	assert.deepEqual(compactCalls, []);
	assert.deepEqual(extension.sentMessages, ["Investigate the deployment"]);
	assert.equal(extension.appendedEntries.at(-1).data.status, "dispatched");
}

{
	const extension = registerExtension();
	const compactCalls = [];
	const { ctx, compactModel, originalModel } = createContext(80_001, compactCalls);
	extension.handlers.get("session_start")({}, ctx);
	assert.deepEqual(compactCalls, []);
	await flushDeferredBtw2Start();

	assert.deepEqual(extension.modelChanges, [compactModel]);
	assert.deepEqual(extension.thinkingChanges, ["minimal"]);
	assert.equal(extension.sentMessages.length, 0);
	assert.equal(compactCalls.length, 1);
	assert.match(compactCalls[0].customInstructions, /Investigate the deployment/);

	compactCalls[0].onComplete({});
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(extension.modelChanges, [compactModel, originalModel]);
	assert.deepEqual(extension.thinkingChanges, ["minimal", "high"]);
	assert.deepEqual(extension.sentMessages, ["Investigate the deployment"]);
	assert.equal(extension.appendedEntries.at(-1).data.status, "dispatched");
	assert.equal(extension.appendedEntries.at(-1).data.compacted, true);
}

{
	const extension = registerExtension();
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-btw2-test-"));
	const sessionDirectory = path.join(temporaryDirectory, "sessions");
	const sourceManager = SessionManager.create(temporaryDirectory, sessionDirectory);
	sourceManager.appendMessage({
		role: "user",
		content: "Parent task",
		timestamp: Date.now(),
	});
	sourceManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Parent result" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const sourceFile = sourceManager.getSessionFile();
	assert.ok(sourceFile);
	const originalForkCommand = process.env.PI_FORK_COMMAND;
	process.env.PI_FORK_COMMAND = "true";
	try {
		await extension.commands.get("btw2").handler("Investigate the deployment", {
			cwd: temporaryDirectory,
			isIdle() {
				return true;
			},
			sessionManager: sourceManager,
			ui: { notify() {} },
		});

		const sessionFiles = await fs.readdir(sessionDirectory);
		const childName = sessionFiles.find((name) => path.join(sessionDirectory, name) !== sourceFile);
		assert.ok(childName);
		const childManager = SessionManager.open(path.join(sessionDirectory, childName));
		const taskEntry = childManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "btw2-task");
		assert.deepEqual(taskEntry?.data, { task: "Investigate the deployment" });
	} finally {
		if (originalForkCommand === undefined) {
			delete process.env.PI_FORK_COMMAND;
		} else {
			process.env.PI_FORK_COMMAND = originalForkCommand;
		}
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
}

{
	const extension = registerExtension();
	const compactCalls = [];
	const { ctx, compactModel, originalModel } = createContext(100_000, compactCalls);
	extension.handlers.get("session_start")({}, ctx);
	await flushDeferredBtw2Start();

	const compactionError = new Error("summary timed out");
	compactCalls[0].onError(compactionError);
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(extension.modelChanges, [compactModel, originalModel]);
	assert.deepEqual(extension.thinkingChanges, ["minimal", "high"]);
	assert.deepEqual(extension.sentMessages, ["Investigate the deployment"]);
	assert.equal(extension.appendedEntries.at(-1).data.compacted, false);
	assert.equal(extension.appendedEntries.at(-1).data.error, "summary timed out");
}

console.log("fork-terminal extension tests passed");
