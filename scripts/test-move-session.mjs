import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const moveSessionModule = await jiti.import("../extensions/move-session.ts");

const originalCwd = process.cwd();
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-move-session-test-"));
const sourceCwd = path.join(temporaryDirectory, "source");
const targetCwd = path.join(temporaryDirectory, "target");
const sessionDirectory = path.join(temporaryDirectory, "sessions");

await fs.mkdir(sourceCwd, { recursive: true });

try {
	const sourceManager = SessionManager.create(sourceCwd, sessionDirectory);
	sourceManager.appendMessage({
		role: "user",
		content: "Move this session",
		timestamp: Date.now(),
	});
	sourceManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Ready" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sourceFile = sourceManager.getSessionFile();
	assert.ok(sourceFile);

	let command;
	moveSessionModule.default({
		on() {},
		registerCommand(name, definition) {
			if (name === "move-session") {
				command = definition;
			}
		},
	});
	assert.ok(command);

	let movedFile;
	process.chdir(sourceCwd);
	await command.handler(targetCwd, {
		cwd: sourceCwd,
		sessionManager: sourceManager,
		ui: { notify() {} },
		waitForIdle: async () => {},
		switchSession: async (sessionFile, options) => {
			assert.equal(process.cwd(), targetCwd);
			movedFile = sessionFile;
			const movedManager = SessionManager.open(sessionFile);
			assert.equal(movedManager.getCwd(), targetCwd);
			await options.withSession({ cwd: targetCwd, ui: { notify() {} } });
			return { cancelled: false };
		},
	});
	assert.ok(movedFile);
	assert.equal(process.cwd(), targetCwd);

	const movedManager = SessionManager.open(movedFile);
	let repaired = false;
	process.chdir(sourceCwd);
	await command.handler(targetCwd, {
		cwd: targetCwd,
		sessionManager: movedManager,
		ui: { notify() {} },
		waitForIdle: async () => {},
		switchSession: async (sessionFile, options) => {
			repaired = true;
			assert.equal(sessionFile, movedFile);
			assert.equal(process.cwd(), targetCwd);
			await options.withSession({ cwd: targetCwd, ui: { notify() {} } });
			return { cancelled: false };
		},
	});
	assert.equal(repaired, true);
	assert.equal(process.cwd(), targetCwd);
} finally {
	process.chdir(originalCwd);
	await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("move-session extension tests passed");
