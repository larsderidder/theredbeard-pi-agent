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
];

assert.equal(lazyToolsTestApi.groupForTool("read"), undefined);
assert.equal(lazyToolsTestApi.groupForTool("browser_navigate"), "browser");
assert.equal(lazyToolsTestApi.groupForTool("search_gmail"), "personal-history");
assert.equal(lazyToolsTestApi.groupForTool("outline_search"), "documents");
assert.equal(lazyToolsTestApi.groupForTool("kubectl_exec"), "infrastructure");

assert.deepEqual(
	lazyToolsTestApi.findMatchingTools(tools, "browser automation", 10),
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
	lazyToolsTestApi.findMatchingTools(tools, "test driven development", 10),
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
const result = await searchTools.execute("test", { query: "browser automation", limit: 10 });
assert.deepEqual(result.details.added, ["browser_click", "browser_navigate"]);
assert.deepEqual(activeTools.sort(), ["browser_click", "browser_navigate", "read", "search_tools", "todo"]);

console.log("lazy tool tests passed");
