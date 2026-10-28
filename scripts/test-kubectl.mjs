import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(os.tmpdir(), "pi-kubectl-"));
mock.method(os, "homedir", () => root);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const register = await jiti.import("../extensions/kubectl.ts", { default: true });

/** Register the real extension with mocked execution and approval UI. */
function runtime(choices = []) {
	const handlers = new Map();
	const calls = [];
	let tool;
	let prompts = 0;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool(definition) {
			tool = definition;
		},
		async exec(command, args, options) {
			calls.push({ command, args, options });
			return { stdout: "pods", stderr: "", code: 0 };
		},
	};
	register(pi);
	return {
		pi,
		tool,
		handlers,
		calls,
		ctx: {
			hasUI: true,
			ui: {
				async select() {
					prompts += 1;
					return choices.shift();
				},
			},
		},
		prompts: () => prompts,
	};
}

/** Run a tool call against the fixture context without touching a cluster. */
async function run(state, args, options = {}) {
	return state.tool.execute("test", { context: "production", args, ...options }, undefined, undefined, state.ctx);
}

try {
	const read = runtime();
	assert.equal(read.tool.name, "kubectl_exec");
	assert.ok(read.tool.parameters.required.includes("context"));
	assert.ok(read.tool.parameters.required.includes("args"));
	const result = await run(read, ["get", "pods", "-n", "default"]);
	assert.equal(result.isError, false);
	assert.deepEqual(read.calls[0].args, ["--context", "production", "--request-timeout=60s", "get", "pods", "-n", "default"]);
	assert.equal(read.prompts(), 0);

	for (const args of [["get", "pods", "--context=other"], ["get", "pods", "--raw=/api"], ["config", "view"]]) {
		const blocked = runtime();
		assert.equal((await run(blocked, args)).details.blocked, true);
		assert.equal(blocked.calls.length, 0);
	}

	for (const args of [["get", "secrets"], ["exec", "pod/api", "--", "id"]]) {
		const blocked = runtime();
		assert.equal((await run(blocked, args)).details.blocked, true);
		assert.equal(blocked.calls.length, 0);
		assert.equal(blocked.prompts(), 0);
	}

	const headless = runtime();
	headless.ctx.hasUI = false;
	assert.equal((await run(headless, ["rollout", "restart", "deployment/api"])).details.blocked, true);
	assert.equal(headless.calls.length, 0);

	const denied = runtime(["Deny"]);
	assert.equal((await run(denied, ["rollout", "restart", "deployment/api"])).details.blocked, true);
	assert.equal(denied.calls.length, 0);

	const approved = runtime(["Allow this context this turn", "Allow once"]);
	await approved.handlers.get("agent_start")();
	await run(approved, ["rollout", "restart", "deployment/api"]);
	await run(approved, ["rollout", "restart", "deployment/worker"]);
	assert.equal(approved.prompts(), 1);
	assert.equal(approved.calls.length, 2);
	await approved.handlers.get("agent_end")();
	await run(approved, ["rollout", "restart", "deployment/api"]);
	assert.equal(approved.prompts(), 2);

	const failed = runtime(["Allow once", "Allow once"]);
	const exec = failed.pi.exec;
	failed.pi.exec = async () => { throw new Error("exec failed"); };
	assert.equal((await run(failed, ["rollout", "restart", "deployment/api"])).isError, true);
	failed.pi.exec = exec;
	assert.equal((await run(failed, ["rollout", "restart", "deployment/api"])).isError, false);
	assert.equal(failed.calls.length, 1);

	const guard = runtime();
	const handler = guard.handlers.get("tool_call");
	assert.equal((await handler({ toolName: "bash", input: { command: "kubectl get pods" } })).block, true);
	assert.equal(await handler({ toolName: "bash", input: { command: "git status --short" } }), undefined);
	for (const command of [
		"python3 - <<'PY'\nprint(dict(k for k in []))\nPY",
		'python3 - <<"PY"\nprint(dict(k for k in []))\nPY',
		"python3 - <<-'PY'\n\tprint(dict(k for k in []))\n\tPY",
		"/usr/bin/python3 - <<'PY'\nprint(dict(k for k in []))\nPY",
		"python3 - <<'PY'\nprint(dict(k for k in []))\nPY\ngit status --short",
	]) {
		assert.equal(await handler({ toolName: "bash", input: { command } }), undefined, command);
	}
	for (const command of [
		"k get pods",
		"(k get pods)",
		"sudo kubectl get pods",
		"python3 - <<'PY'\nprint(dict(k for k in []))\nPY\nk get pods",
		"python3 - <<'PY'\nkubectl get pods\nPY",
		"python3 - <<PY\n$(k get pods)\nPY",
		"echo \"start\npython3 - <<'PY'\n$(k get pods)\nPY\n\"",
		"cat <<'PY'\n(k for k in [])\nPY\nkubectl get pods",
		"cat <<'PY'; kubectl get pods\n(k for k in [])\nPY",
		"cat <<PY\n$(kubectl get pods)\nPY",
		"cat <<FIRST <<'SECOND'\n$(kubectl get pods)\nFIRST\nliteral\nSECOND",
		"cat <<\\FIRST <<'SECOND'\nliteral\nFIRST\nliteral\nSECOND\nkubectl get pods",
		"bash <<'SH'\nkubectl get pods\nSH",
		"env bash <<'SH'\nkubectl get pods\nSH",
		"/bin/sh <<'SH'\nk get pods\nSH",
		"echo \"<<'PY'\"\nkubectl get pods\nPY",
		"# <<'PY'\nkubectl get pods\nPY",
	]) {
		assert.equal((await handler({ toolName: "bash", input: { command } })).block, true, command);
	}
	console.log("kubectl tests passed");
} finally {
	mock.restoreAll();
	rmSync(root, { recursive: true, force: true });
}
