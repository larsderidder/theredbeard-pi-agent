export interface TodoLinks {
	id: string;
	status: string;
	assigned_to_session?: string;
	depends_on?: string[];
	parent_id?: string;
}

export interface TodoRelationshipState {
	blocked_by: string[];
	subtask_ids: string[];
	subtasks_done: number;
	ready: boolean;
}

/** Legacy closed tasks satisfy prerequisites just like tasks accepted as done. */
export function isTodoComplete(status: string): boolean {
	return ["done", "closed"].includes(status.toLowerCase());
}

/** Derive blockers from explicit prerequisites and unfinished direct subtasks. */
export function describeTodos<T extends TodoLinks>(todos: T[]): Array<T & TodoRelationshipState> {
	const byId = new Map(todos.map((todo) => [todo.id, todo]));
	const children = new Map<string, T[]>();
	for (const todo of todos) {
		if (todo.parent_id) {
			const siblings = children.get(todo.parent_id) ?? [];
			siblings.push(todo);
			children.set(todo.parent_id, siblings);
		}
	}
	return todos.map((todo) => {
		const subtasks = children.get(todo.id) ?? [];
		const prerequisites = new Set(todo.depends_on ?? []);
		for (const child of subtasks) {
			prerequisites.add(child.id);
		}
		const blockedBy: string[] = [];
		for (const id of prerequisites) {
			const prerequisite = byId.get(id);
			if (!prerequisite || !isTodoComplete(prerequisite.status)) {
				blockedBy.push(id);
			}
		}
		// A missing parent is not permission to treat an orphan as available work.
		if (todo.parent_id && !byId.has(todo.parent_id)) {
			blockedBy.push(todo.parent_id);
		}
		return {
			...todo,
			blocked_by: [...new Set(blockedBy)],
			subtask_ids: subtasks.map((child) => child.id),
			subtasks_done: subtasks.filter((child) => isTodoComplete(child.status)).length,
			ready: todo.status.toLowerCase() === "open" && !todo.assigned_to_session && blockedBy.length === 0,
		};
	});
}

/** Validate the proposed graph, including cycles mixing dependencies and subtasks. */
export function validateTodoChange(todo: TodoLinks, existing: TodoLinks[]): string | undefined {
	const byId = new Map(existing.map((item) => [item.id, item]));
	byId.set(todo.id, todo);
	for (const id of [...(todo.depends_on ?? []), todo.parent_id].filter((id): id is string => id !== undefined)) {
		if (!/^[a-f0-9]{8}$/.test(id)) {
			return "Invalid related todo id. Expected TODO-<hex> or a raw hex id.";
		}
		if (id === todo.id) {
			return "A todo cannot depend on itself or be its own parent.";
		}
		if (!byId.has(id)) {
			return `Related todo TODO-${id} not found.`;
		}
	}
	if (todo.parent_id && isTodoComplete(byId.get(todo.parent_id)!.status) && !isTodoComplete(todo.status)) {
		return "Reopen the completed parent before adding or reopening an unfinished subtask.";
	}
	const edges = new Map<string, Set<string>>();
	for (const item of byId.values()) {
		edges.set(item.id, new Set(item.depends_on ?? []));
	}
	for (const item of byId.values()) {
		if (item.parent_id) {
			edges.get(item.parent_id)?.add(item.id);
		}
	}

	// Iterative DFS avoids stack overflow on deeply nested imported task trees.
	const visited = new Set<string>();
	const visiting = new Set<string>();
	for (const id of byId.keys()) {
		const stack = [{ id, leaving: false }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current.leaving) {
				visiting.delete(current.id);
				visited.add(current.id);
				continue;
			}
			if (visiting.has(current.id)) {
				return "Dependencies and subtasks cannot form a cycle.";
			}
			if (visited.has(current.id)) {
				continue;
			}
			visiting.add(current.id);
			stack.push({ id: current.id, leaving: true });
			for (const next of edges.get(current.id) ?? []) {
				stack.push({ id: next, leaving: false });
			}
		}
	}
	if (isTodoComplete(todo.status)) {
		const state = describeTodos([...byId.values()]).find((item) => item.id === todo.id)!;
		if (state.blocked_by.length > 0) {
			return `Cannot complete todo while blocked by ${state.blocked_by.map((id) => `TODO-${id}`).join(", ")}.`;
		}
	}
	return undefined;
}

/** Keep referenced records so cleanup and deletion cannot leave dangling links. */
export function referencedTodoIds(todos: TodoLinks[]): Set<string> {
	const ids = new Set<string>();
	for (const todo of todos) {
		for (const id of todo.depends_on ?? []) {
			ids.add(id);
		}
		if (todo.parent_id) {
			ids.add(todo.parent_id);
			ids.add(todo.id);
		}
	}
	return ids;
}
