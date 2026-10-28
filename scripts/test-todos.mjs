import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: todosExtension } = await jiti.import("../extensions/todos.ts");
const { describeTodos, validateTodoChange } = await jiti.import("../lib/todo-relationships.ts");
// Every fixture uses its own directory, never the operator's configured task store.
delete process.env.PI_TODO_PATH;
delete process.env.PI_PROJECT_PATH;

async function fixture(t) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todos-test-"));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const handlers = new Map();
	let tool;
	todosExtension({
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerTool(value) {
			tool = value;
		},
		registerCommand() {},
	});
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-one",
			getSessionFile: () => path.join(cwd, "session.jsonl"),
		},
		ui: { confirm: async () => false },
	};
	const call = (params, context = ctx) => tool.execute("test", params, undefined, undefined, context);
	const create = async (title, params = {}) => {
		const result = await call({ action: "create", title, ...params });
		assert.equal(result.details.error, undefined);
		return result.details.todo;
	};
	const get = async (id) => (await call({ action: "get", id })).details.todo;
	return { cwd, ctx, call, create, get, handlers, tool };
}

test("dependencies stay blocked through review, unblock at done, and persist across reads", async (t) => {
	const { call, create, get } = await fixture(t);
	const prerequisite = await create("Prerequisite");
	const dependent = await create("Dependent", { depends_on: [`TODO-${prerequisite.id.toUpperCase()}`, prerequisite.id] });
	assert.deepEqual(dependent.depends_on, [prerequisite.id]);
	assert.deepEqual(dependent.blocked_by, [prerequisite.id]);
	assert.equal(dependent.ready, false);
	assert.deepEqual((await call({ action: "ready" })).details.todos.map((todo) => todo.id), [prerequisite.id]);
	assert.deepEqual((await call({ action: "blocked" })).details.todos.map((todo) => todo.id), [dependent.id]);
	assert.match((await call({ action: "claim", id: dependent.id, force: true })).details.error, /not ready/);
	assert.match((await call({ action: "update", id: dependent.id, status: "done" })).details.error, /Cannot complete/);
	await call({ action: "update", id: prerequisite.id, status: "review" });
	assert.deepEqual((await get(dependent.id)).blocked_by, [prerequisite.id]);
	assert.match((await call({ action: "claim", id: prerequisite.id })).details.error, /not ready/);
	await call({ action: "update", id: prerequisite.id, status: "done" });
	assert.equal((await get(dependent.id)).ready, true);
	const claimed = await call({ action: "claim", id: dependent.id });
	assert.equal(claimed.details.todo.ready, false);
	assert.deepEqual((await call({ action: "ready" })).details.todos, []);
	await call({ action: "release", id: dependent.id });
	assert.equal((await get(dependent.id)).ready, true);
});

test("subtasks block their parent without completing it automatically", async (t) => {
	const { call, create, get } = await fixture(t);
	const parent = await create("Parent");
	const child = await create("Child", { parent_id: `TODO-${parent.id}` });
	const grandchild = await create("Grandchild", { parent_id: child.id });
	assert.deepEqual((await get(parent.id)).subtask_ids, [child.id]);
	assert.deepEqual((await get(parent.id)).blocked_by, [child.id]);
	assert.equal((await get(child.id)).ready, false);
	assert.equal((await get(grandchild.id)).ready, true);
	assert.match((await call({ action: "update", id: parent.id, status: "closed" })).details.error, /Cannot complete/);
	await call({ action: "update", id: grandchild.id, status: "done" });
	assert.equal((await get(child.id)).ready, true);
	await call({ action: "update", id: child.id, status: "review" });
	assert.equal((await get(parent.id)).subtasks_done, 0);
	await call({ action: "update", id: child.id, status: "done" });
	assert.equal((await get(parent.id)).subtasks_done, 1);
	assert.equal((await get(parent.id)).status, "open");
	assert.equal((await get(parent.id)).ready, true);
	assert.deepEqual((await call({ action: "list-all", filter: { parent_id: `TODO-${parent.id.toUpperCase()}` } })).details.todos.map((todo) => todo.id), [child.id]);
	await call({ action: "update", id: child.id, clear_parent: true });
	assert.deepEqual((await get(parent.id)).subtask_ids, []);
	assert.equal((await get(child.id)).parent_id, undefined);
});

test("reject missing, invalid, self, dependency, hierarchy, and mixed cycles without saving", async (t) => {
	const { call, create, get } = await fixture(t);
	const a = await create("A");
	const b = await create("B", { depends_on: [a.id] });
	assert.match((await call({ action: "create", title: "Missing", parent_id: "00000000" })).details.error, /not found/);
	assert.match((await call({ action: "create", title: "Invalid", depends_on: ["../../etc/passwd"] })).details.error, /Invalid todo id/);
	assert.match((await call({ action: "update", id: a.id, depends_on: [a.id] })).details.error, /itself/);
	assert.match((await call({ action: "update", id: a.id, parent_id: a.id })).details.error, /own parent/);
	assert.match((await call({ action: "update", id: a.id, depends_on: [b.id] })).details.error, /cycle/);
	assert.match((await call({ action: "update", id: b.id, parent_id: a.id })).details.error, /cycle/);
	assert.equal((await get(b.id)).parent_id, undefined);
	await call({ action: "update", id: b.id, depends_on: [], parent_id: a.id });
	assert.match((await call({ action: "update", id: a.id, parent_id: b.id })).details.error, /cycle/);
	assert.match((await call({ action: "update", id: b.id, parent_id: a.id, clear_parent: true })).details.error, /cannot be used together/);
	assert.deepEqual((await get(a.id)).depends_on, undefined);
});

test("list filters compose and batch updates validate relationship changes", async (t) => {
	const { call, create, get } = await fixture(t);
	const parent = await create("Parent");
	const prerequisite = await create("Prerequisite");
	const child = await create("Child", { parent_id: parent.id, tags: ["Work"] });
	const childTwo = await create("Child two", { parent_id: parent.id });
	const filtered = await call({ action: "ready", filter: { parent_id: parent.id, tags: ["work"] } });
	assert.deepEqual(filtered.details.todos.map((todo) => todo.id), [child.id]);
	const batch = await call({ action: "batch-update", filter: { parent_id: parent.id }, depends_on: [prerequisite.id] });
	assert.equal(batch.details.updated.length, 2);
	assert.equal((await get(child.id)).ready, false);
	assert.equal((await call({ action: "list", filter: { blocked: true, parent_id: parent.id } })).details.todos.length, 2);
	const bad = await call({ action: "batch-update", ids: [prerequisite.id], depends_on: [child.id] });
	assert.match(bad.details.skipped[0].reason, /cycle/);
	await call({ action: "batch-update", ids: [child.id, childTwo.id], depends_on: [], clear_parent: true });
	assert.equal((await get(child.id)).parent_id, undefined);
	assert.deepEqual((await get(childTwo.id)).depends_on, []);
	assert.match((await call({ action: "list", filter: { parent_id: "../bad" } })).details.error, /Invalid parent/);
	assert.match((await call({ action: "batch-update", filter: { parent_id: "../bad" }, tags: [] })).details.error, /Invalid parent/);
});

test("incoming references prevent deletion; leaf subtasks can be deleted", async (t) => {
	const { call, create, get } = await fixture(t);
	const parent = await create("Parent");
	const child = await create("Child", { parent_id: parent.id });
	const dependent = await create("Dependent", { depends_on: [child.id] });
	assert.match((await call({ action: "delete", id: parent.id })).details.error, /referenced/);
	assert.match((await call({ action: "delete", id: child.id })).details.error, /referenced/);
	await call({ action: "update", id: dependent.id, depends_on: [] });
	assert.equal((await call({ action: "delete", id: child.id })).details.error, undefined);
	assert.deepEqual((await get(parent.id)).subtask_ids, []);
});

test("cleanup retains completed prerequisites and subtask progress, but removes unrelated old tasks", async (t) => {
	const { cwd, ctx, call, create, get, handlers } = await fixture(t);
	const prerequisite = await create("Prerequisite", { status: "done" });
	const dependent = await create("Dependent", { depends_on: [prerequisite.id] });
	const parent = await create("Parent");
	const child = await create("Child", { parent_id: parent.id, status: "closed" });
	const unrelated = await create("Unrelated", { status: "done" });
	const todosDir = path.join(cwd, ".pi/todos");
	for (const todo of [prerequisite, child, unrelated]) {
		const filePath = path.join(todosDir, `${todo.id}.md`);
		const raw = await fs.readFile(filePath, "utf8");
		await fs.writeFile(filePath, raw.replace(todo.created_at, "2000-01-01T00:00:00.000Z"));
	}
	await handlers.get("session_start")({}, ctx);
	assert.equal((await get(dependent.id)).ready, true);
	assert.deepEqual((await get(parent.id)).subtask_ids, [child.id]);
	assert.equal((await get(parent.id)).subtasks_done, 1);
	assert.equal((await call({ action: "get", id: unrelated.id })).details.error, "not found");
	const stored = await fs.readFile(path.join(todosDir, `${dependent.id}.md`), "utf8");
	assert.doesNotMatch(stored, /blocked_by|subtask_ids|"ready"/);
});

test("concurrent graph mutations cannot create a cycle or delete a new prerequisite", async (t) => {
	const { call, create, get } = await fixture(t);
	const a = await create("A");
	const b = await create("B");
	const results = await Promise.all([
		call({ action: "update", id: a.id, depends_on: [b.id] }),
		call({ action: "update", id: b.id, depends_on: [a.id] }),
	]);
	assert.equal(results.filter((result) => result.details.error).length, 1);
	assert.match(results.find((result) => result.details.error).details.error, /cycle/);
	const prerequisite = await create("Prerequisite");
	const dependent = await create("Dependent");
	const race = await Promise.all([
		call({ action: "update", id: dependent.id, depends_on: [prerequisite.id] }),
		call({ action: "delete", id: prerequisite.id }),
	]);
	assert.equal(race.filter((result) => result.details.error).length, 1);
	assert.ok(await get(prerequisite.id));
});

test("missing imported references fail closed and review/assigned tasks are not ready", () => {
	const todos = describeTodos([
		{ id: "00000001", status: "open", depends_on: ["00000000"] },
		{ id: "00000002", status: "open", parent_id: "00000000" },
		{ id: "00000003", status: "review" },
		{ id: "00000004", status: "open", assigned_to_session: "someone" },
	]);
	assert.ok(todos.every((todo) => !todo.ready));
	assert.deepEqual(todos[0].blocked_by, ["00000000"]);
	assert.deepEqual(todos[1].blocked_by, ["00000000"]);
});

test("shared prerequisites are not cycles and deep hierarchies do not overflow", () => {
	const root = { id: "00000001", status: "open", depends_on: ["00000002", "00000003"] };
	const diamond = [root, { id: "00000002", status: "open", depends_on: ["00000003"] }, { id: "00000003", status: "open" }];
	assert.equal(validateTodoChange(root, diamond), undefined);
	const chain = Array.from({ length: 12000 }, (_, index) => {
		const todo = { id: index.toString(16).padStart(8, "0"), status: "open" };
		if (index > 0) {
			todo.parent_id = (index - 1).toString(16).padStart(8, "0");
		}
		return todo;
	});
	assert.equal(validateTodoChange(chain.at(-1), chain), undefined);
	assert.match(validateTodoChange({ ...chain[0], parent_id: chain.at(-1).id }, chain), /cycle/);
});


test("completed parents must be reopened before adding or reopening unfinished subtasks", async (t) => {
	const { call, create, get } = await fixture(t);
	const parent = await create("Completed parent", { status: "done" });
	assert.match((await call({ action: "create", title: "New child", parent_id: parent.id })).details.error, /Reopen the completed parent/);
	const child = await create("Completed child", { parent_id: parent.id, status: "done" });
	assert.match((await call({ action: "update", id: child.id, status: "open" })).details.error, /Reopen the completed parent/);
	await call({ action: "update", id: parent.id, status: "open" });
	assert.equal((await call({ action: "update", id: child.id, status: "open" })).details.error, undefined);
	assert.equal((await get(parent.id)).ready, false);
});

test("a store lock held by another process blocks mutation and cleanup", async (t) => {
	const { cwd, ctx, call, create, get, handlers } = await fixture(t);
	const todo = await create("Task");
	const lockPath = path.join(cwd, ".pi/todos/graph.lock");
	await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, session: "other-session" }));
	assert.match((await call({ action: "update", id: todo.id, title: "Should not save" })).details.error, /relationships is locked/);
	await handlers.get("session_start")({}, ctx);
	assert.equal((await get(todo.id)).title, "Task");
	await fs.unlink(lockPath);
	assert.equal((await call({ action: "claim", id: todo.id })).details.error, undefined);
	const otherContext = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "session-two" } };
	assert.match((await call({ action: "claim", id: todo.id }, otherContext)).details.error, /already assigned/);
});

test("expanded tool output shows parent, dependencies, subtasks, and blockers", async (t) => {
	const { call, create, tool } = await fixture(t);
	const parent = await create("Parent");
	const prerequisite = await create("Prerequisite");
	const child = await create("Child", { parent_id: parent.id, depends_on: [prerequisite.id] });
	const result = await call({ action: "get", id: child.id });
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n");
	assert.ok(rendered.includes(`Parent: TODO-${parent.id}`));
	assert.ok(rendered.includes(`Depends on: TODO-${prerequisite.id}`));
	assert.ok(rendered.includes(`Blocked by: TODO-${prerequisite.id}`));
	const parentResult = await call({ action: "get", id: parent.id });
	const parentRendered = tool.renderResult(parentResult, { expanded: true, isPartial: false }, theme).render(120).join("\n");
	assert.ok(parentRendered.includes(`Subtasks (0/1 done): TODO-${child.id}`));
});
