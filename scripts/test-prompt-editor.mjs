import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: registerPromptEditor } = await jiti.import("../extensions/prompt-editor.ts");
initTheme("dark", false);

const alpha = { provider: "first", id: "alpha", name: "Alpha" };
const beta = { provider: "second", id: "beta", name: "Beta" };

async function editModel(t, models, interact) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-editor-test-"));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const filePath = path.join(cwd, ".pi", "modes.json");
	const original = {
		version: 1,
		currentMode: "default",
		modes: {
			default: { provider: alpha.provider, modelId: alpha.id },
			review: { provider: alpha.provider, modelId: alpha.id },
		},
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(original));
	const commands = new Map();
	registerPromptEditor({
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerShortcut() {},
		on() {},
		getThinkingLevel: () => "off",
	});
	const notifications = [];
	let selectCount = 0;
	let customCount = 0;
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: alpha,
		modelRegistry: {
			getAvailable: () => models,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			select: async (_title, options) => {
				selectCount++;
				if (selectCount === 1) {
					return options.at(-1);
				}
				if (selectCount === 2) {
					return "review";
				}
				if (selectCount === 3) {
					return "Change model";
				}
				return undefined;
			},
			custom: async (factory) => {
				customCount++;
				let completed = false;
				let selection;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color, text) => text },
					getKeybindings(),
					(value) => {
						assert.equal(completed, false, "the picker must complete only once");
						completed = true;
						selection = value;
					},
				);
				component.focused = true;
				assert.equal(component.focused, true);
				await interact(component);
				assert.equal(completed, true, "the picker must complete or cancel");
				return selection;
			},
		},
	};
	await commands.get("mode").handler("", ctx);
	return { original, saved: JSON.parse(await fs.readFile(filePath, "utf8")), notifications, customCount };
}

test("prompt mode model picker searches by model and provider, and persists the selection", async (t) => {
	const duplicate = { provider: "third", id: beta.id, name: "Other Beta" };
	const result = await editModel(t, [alpha, duplicate, beta], (component) => {
		for (const character of "second beta") {
			component.handleInput(character);
		}
		const lines = component.render(120).join("\n");
		assert.ok(lines.includes("second Beta"));
		assert.ok(!lines.includes("third Other Beta"));
		component.handleInput("\r");
	});
	assert.deepEqual(result.saved.modes.review, { provider: beta.provider, modelId: beta.id });
	assert.deepEqual(result.saved.modes.default, result.original.modes.default);
});

test("prompt mode model picker preserves the current selection and fits narrow terminals", async (t) => {
	const result = await editModel(t, [beta, alpha], (component) => {
		for (const width of [20, 40, 80]) {
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
		}
		component.invalidate();
		component.handleInput("\r");
	});
	assert.deepEqual(result.saved, result.original);
});

test("cancelling a filtered prompt mode model picker leaves the mode unchanged", async (t) => {
	const result = await editModel(t, [alpha, beta], (component) => {
		component.handleInput("no-such-model");
		component.handleInput("\r");
		component.handleInput("\x1b");
	});
	assert.deepEqual(result.saved, result.original);
});

test("prompt mode model picker reports an empty catalog without opening a dialog", async (t) => {
	const result = await editModel(t, [], () => assert.fail("must not open an empty picker"));
	assert.equal(result.customCount, 0);
	assert.deepEqual(result.saved, result.original);
	assert.ok(result.notifications.some((notice) => notice.level === "warning" && /No models available/.test(notice.message)));
});
