import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const projectModule = await jiti.import("../extensions/projects.ts");
const todoModule = await jiti.import("../extensions/todos.ts");
const { projectTestApi } = projectModule;
const { todoProjectTestApi } = todoModule;

const now = "2026-07-30T10:00:00.000Z";
const later = "2026-07-30T11:00:00.000Z";

{
	assert.equal(projectTestApi.validateProjectId("PROJECT-DeAdBeEf").id, "deadbeef");
	assert.equal(projectTestApi.validateProjectId("#deadbeef").id, "deadbeef");
	assert.match(projectTestApi.validateProjectId("../../etc/passwd").error, /Invalid project id/);
}

{
	const project = {
		id: "deadbeef",
		title: "Persistent project work",
		tags: ["pi", "agents"],
		status: "active",
		created_at: now,
		updated_at: later,
		sessions: [
			{
				session_id: "session-1",
				session_file: "/tmp/session-1.jsonl",
				session_name: "Build project extension",
				cwd: "/tmp/project",
				first_worked_at: now,
				last_worked_at: later,
			},
		],
		body: "A broad description.\n",
	};
	const serialized = projectTestApi.serializeProject(project);
	assert.deepEqual(projectTestApi.parseProjectContent(serialized, project.id), project);
}

{
	const sessions = [];
	projectTestApi.upsertSessionWork(sessions, {
		session_id: "session-1",
		cwd: "/tmp/project",
		first_worked_at: now,
		last_worked_at: now,
	});
	projectTestApi.upsertSessionWork(sessions, {
		session_id: "session-1",
		session_name: "Renamed session",
		cwd: "/tmp/project",
		first_worked_at: later,
		last_worked_at: later,
	});
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].first_worked_at, now);
	assert.equal(sessions[0].last_worked_at, later);
	assert.equal(sessions[0].session_name, "Renamed session");
}

{
	const todo = {
		id: "1234abcd",
		title: "Implement project tool",
		tags: [],
		status: "open",
		created_at: now,
		assigned_to_session: undefined,
		project_id: "deadbeef",
		body: "Todo details.\n",
	};
	const serialized = todoProjectTestApi.serializeTodo(todo);
	assert.deepEqual(todoProjectTestApi.parseTodoContent(serialized, todo.id), todo);
	assert.equal(todoProjectTestApi.normalizeProjectId("PROJECT-DEADBEEF"), "deadbeef");
	assert.equal(todoProjectTestApi.isValidProjectId("../../etc/passwd"), false);
}

{
	const temporaryCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-projects-test-"));
	const tools = new Map();
	const entries = [];
	const pi = {
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		getSessionName() {
			return "Project integration test";
		},
		on() {},
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	};
	const ctx = {
		cwd: temporaryCwd,
		hasUI: false,
		sessionManager: {
			getBranch() {
				return entries;
			},
			getSessionFile() {
				return "/tmp/session-1.jsonl";
			},
			getSessionId() {
				return "session-1";
			},
		},
		ui: {
			confirm: async () => false,
			notify() {},
			setStatus() {},
		},
	};

	try {
		projectModule.default(pi);
		todoModule.default(pi);
		const projectTool = tools.get("project");
		const todoTool = tools.get("todo");
		assert.ok(projectTool);
		assert.ok(todoTool);

		const createdProject = await projectTool.execute("project-create", {
			action: "create",
			title: "Cross-session project",
			tags: ["pi"],
			body: "Broad project description",
		}, undefined, undefined, ctx);
		assert.equal(createdProject.details.action, "create");
		const projectId = createdProject.details.project.id;

		const createdTodo = await todoTool.execute("todo-create", {
			action: "create",
			title: "Detailed task",
			project_id: `PROJECT-${projectId}`,
		}, undefined, undefined, ctx);
		assert.equal(createdTodo.details.todo.project_id, projectId);

		const projectWithTodo = await projectTool.execute("project-get", {
			action: "get",
			id: projectId,
		}, undefined, undefined, ctx);
		assert.equal(projectWithTodo.details.relatedTodos.length, 1);
		assert.equal(projectWithTodo.details.relatedTodos[0].title, "Detailed task");

		await projectTool.execute("project-work-1", {
			action: "mark-worked",
			id: projectId,
		}, undefined, undefined, ctx);
		const markedAgain = await projectTool.execute("project-work-2", {
			action: "mark-worked",
			id: projectId,
		}, undefined, undefined, ctx);
		assert.equal(markedAgain.details.project.sessions.length, 1);
		assert.equal(entries.length, 1);

		const blockedDelete = await projectTool.execute("project-delete", {
			action: "delete",
			id: projectId,
		}, undefined, undefined, ctx);
		assert.match(blockedDelete.details.error, /connected todo/);

		const clearedTodo = await todoTool.execute("todo-clear-project", {
			action: "update",
			id: createdTodo.details.todo.id,
			clear_project: true,
		}, undefined, undefined, ctx);
		assert.equal(clearedTodo.details.todo.project_id, undefined);
	} finally {
		await fs.rm(temporaryCwd, { recursive: true, force: true });
	}
}

console.log("project extension tests passed");
