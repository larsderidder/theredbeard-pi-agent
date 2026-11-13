import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const lazyToolsModule = await jiti.import("../extensions/lazy-tools.ts");
const { lazyToolsTestApi } = lazyToolsModule;

const tools = [
	{ name: "read", description: "Read a file" },
	{ name: "todo", description: "Manage todos" },
	{ name: "browser_navigate", description: "Navigate to a URL" },
	{ name: "browser_click", description: "Click a page element" },
	{ name: "web_search", description: "Search the public web" },
	{ name: "argus_extract", description: "Extract a public URL" },
	{ name: "search_browser", description: "Search Firefox browser history" },
	{ name: "search_gmail", description: "Search Gmail messages" },
	{ name: "gdrive_read", description: "Read a Google Drive file" },
	{ name: "outline_search", description: "Search Outline documents" },
	{ name: "hedgedoc_get", description: "Read a HedgeDoc note" },
	{ name: "kubectl_exec", description: "Run kubectl" },
	{ name: "loki_query_sbl-prod", description: "Query production Loki logs" },
	{ name: "godot_screenshot", description: "Capture the Godot project" },
	{ name: "screenshot", description: "Capture local tool output" },
	{ name: "bryti_notify", description: "Notify after a model call" },
];

assert.equal(lazyToolsTestApi.groupForTool("read"), undefined);
assert.equal(lazyToolsTestApi.groupForTool("browser_navigate"), "browser");
assert.equal(lazyToolsTestApi.groupForTool("search_gmail"), "personal-history");
assert.equal(lazyToolsTestApi.groupForTool("outline_search"), "documents");
assert.equal(lazyToolsTestApi.groupForTool("kubectl_exec"), "infrastructure");

assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "browser automation", 1),
	["browser_click", "browser_navigate"],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "search my Gmail and Drive", 10),
	["gdrive_read", "search_browser", "search_gmail"],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "search browser history", 10),
	["gdrive_read", "search_browser", "search_gmail"],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "open URL", 10),
	["argus_extract", "browser_navigate"],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "test driven development", 10),
	[],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(
		tools,
		"Pi documentation or local files for RPC mode commands get active tools without model call",
		50,
	),
	[],
);
assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "Kubernetes and Loki logs", 10),
	["kubectl_exec", "loki_query_sbl-prod"],
);

const registeredTools = new Map();
const handlers = new Map();
let activeTools = tools.map((tool) => tool.name);
const pi = {
	getActiveTools() {
		return activeTools;
	},
	getAllTools() {
		return [
			...tools.map((tool) => ({ ...tool, parameters: {}, sourceInfo: {} })),
			...Array.from(registeredTools.values()),
		];
	},
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerCommand() {},
	registerTool(tool) {
		registeredTools.set(tool.name, tool);
		activeTools.push(tool.name);
	},
	setActiveTools(names) {
		activeTools = names;
	},
};

lazyToolsModule.default(pi);
await handlers.get("session_start")({}, {
	hasUI: false,
	ui: { notify() {} },
});

assert.deepEqual(activeTools.sort(), ["read", "search_tools", "todo"]);

const searchTools = registeredTools.get("search_tools");
assert.ok(searchTools);
const result = await searchTools.execute("test", { query: "browser automation", limit: 1 });
assert.deepEqual(result.details.added, ["browser_click", "browser_navigate"]);
assert.deepEqual(activeTools.sort(), ["browser_click", "browser_navigate", "read", "search_tools", "todo"]);

const genericResult = await searchTools.execute("test", {
	query: "Pi documentation or local files for RPC mode commands get active tools without model call",
});
assert.deepEqual(genericResult.details, { matches: [], added: [] });
assert.deepEqual(activeTools.sort(), ["browser_click", "browser_navigate", "read", "search_tools", "todo"]);

// notFoundToolName parses pi core's "tool not found" error (array and string content).
assert.equal(
	lazyToolsTestApi.notFoundToolName([{ type: "text", text: "Error: Tool 'kubectl_exec' not found" }]),
	"kubectl_exec",
);
assert.equal(lazyToolsTestApi.notFoundToolName("Error: Tool 'nope' not found"), "nope");
assert.equal(lazyToolsTestApi.notFoundToolName([{ type: "text", text: "some other error" }]), undefined);
assert.equal(lazyToolsTestApi.notFoundToolName([]), undefined);

// A direct call to an inactive lazy tool is auto-activated and the error is rewritten
// in place so the model retries the same call.
activeTools = ["read", "todo", "search_tools"];
const endHandler = handlers.get("tool_execution_end");
assert.ok(endHandler);
const endEvent = {
	isError: true,
	toolName: "kubectl_exec",
	result: { content: [{ type: "text", text: "Error: Tool 'kubectl_exec' not found" }] },
};
endHandler(endEvent, {});
assert.ok(activeTools.includes("kubectl_exec"));
assert.match(endEvent.result.content[0].text, /activated automatically; call kubectl_exec again/);

// Unknown tools that are not lazy stay untouched; non-error events are ignored.
const unknownEvent = {
	isError: true,
	toolName: "totally_unknown",
	result: { content: [{ type: "text", text: "Error: Tool 'totally_unknown' not found" }] },
};
endHandler(unknownEvent, {});
assert.equal(activeTools.includes("totally_unknown"), false);
assert.equal(unknownEvent.result.content[0].text, "Error: Tool 'totally_unknown' not found");
endHandler({ isError: false, toolName: "read", result: { content: [] } }, {});

// A "No matching tools found." result from the harness tool_search gets a search_tools hint.
const resultHandler = handlers.get("tool_result");
assert.ok(resultHandler);
const searchEvent = { toolName: "tool_search", content: [{ type: "text", text: "No matching tools found." }], isError: false };
const hookResult = resultHandler(searchEvent, {});
assert.ok(hookResult?.content);
const hintText = hookResult.content.map((block) => block.text ?? "").join("\n");
assert.match(hintText, /search_tools/);
assert.match(hintText, /kubectl_exec/);
assert.match(hintText, /No matching tools found\./);
// Other tools and other results are left alone.
assert.equal(resultHandler({ toolName: "bash", content: [{ type: "text", text: "No matching tools found." }] }, {}), undefined);
assert.equal(resultHandler({ toolName: "tool_search", content: [{ type: "text", text: "Loaded 1 tool..." }] }, {}), undefined);

// appendHintToContent handles string content and content without a text block.
assert.match(String(lazyToolsTestApi.appendHintToContent("No matching tools found.", "\nHINT")), /HINT$/);
const appended = lazyToolsTestApi.appendHintToContent([{ type: "image", data: "x" }], "\nHINT");
assert.deepEqual(appended.at(-1), { type: "text", text: "\nHINT" });

console.log("lazy tool tests passed");
