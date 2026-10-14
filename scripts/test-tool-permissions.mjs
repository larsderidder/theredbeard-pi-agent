import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createApprovalGate } = await jiti.import("theredbeard-pi-agent/tool-permissions");

function createPi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
}

function createContext(choices = []) {
	let selectCalls = 0;
	return {
		context: {
			hasUI: true,
			ui: {
				async select() {
					selectCalls += 1;
					return choices.shift();
				},
			},
		},
		selectCalls() {
			return selectCalls;
		},
	};
}

const request = {
	key: "cluster:production",
	operation: "kubectl apply",
	scopeLabel: "this context",
	prompt: "Risk: confirm\n\nCommand: kubectl apply",
	question: "Allow this kubectl command?",
};

{
	const pi = createPi();
	const events = [];
	const gate = createApprovalGate(pi, {
		onEvent(event) {
			events.push(event);
		},
	});
	const ctx = createContext(["Allow this context this turn", "Allow once"]);

	await pi.handlers.get("agent_start")();
	const first = await gate.authorize(ctx.context, request);
	assert.equal(first.allowed, true);
	assert.equal(first.confirmation, "approved-with-grant");
	first.release();

	const reused = await gate.authorize(ctx.context, request);
	assert.equal(reused.allowed, true);
	assert.equal(reused.confirmation, "approval-grant");
	assert.equal(ctx.selectCalls(), 1);
	assert.equal(reused.grant?.scope, "turn");
	assert.match(reused.grant?.label ?? "", /agent run/);
	reused.release();

	await pi.handlers.get("agent_end")();
	const afterRun = await gate.authorize(ctx.context, request);
	assert.equal(afterRun.allowed, true);
	assert.equal(afterRun.confirmation, "approved-once");
	assert.equal(ctx.selectCalls(), 2);
	afterRun.release();

	assert.deepEqual(events.map((event) => event.type), [
		"prompted",
		"approved",
		"grant-used",
		"prompted",
		"approved",
	]);
}

{
	let now = 1_000;
	const pi = createPi();
	const gate = createApprovalGate(pi, { now: () => now });
	const ctx = createContext(["Allow this context for 5 minutes", "Allow once"]);

	const first = await gate.authorize(ctx.context, request);
	assert.equal(first.allowed, true);
	assert.equal(first.grant?.scope, "time");
	first.release();

	now += 299_999;
	const reused = await gate.authorize(ctx.context, request);
	assert.equal(reused.allowed, true);
	assert.equal(reused.confirmation, "approval-grant");
	reused.release();

	now += 2;
	const expired = await gate.authorize(ctx.context, request);
	assert.equal(expired.allowed, true);
	assert.equal(expired.confirmation, "approved-once");
	assert.equal(ctx.selectCalls(), 2);
	expired.release();
}

{
	const pi = createPi();
	const gate = createApprovalGate(pi);
	const result = await gate.authorize({ hasUI: false, ui: {} }, request);
	assert.deepEqual(result, {
		allowed: false,
		kind: "no-ui",
		reason: "confirmation required but no UI is available",
	});
}

{
	const pi = createPi();
	const gate = createApprovalGate(pi, { concurrency: "reject" });
	const firstContext = createContext(["Allow once"]);
	const secondContext = createContext(["Allow once"]);
	const first = await gate.authorize(firstContext.context, request);
	assert.equal(first.allowed, true);

	const blocked = await gate.authorize(secondContext.context, {
		...request,
		operation: "kubectl delete",
	});
	assert.equal(blocked.allowed, false);
	assert.equal(blocked.kind, "busy");
	assert.match(blocked.reason, /kubectl apply/);

	first.release();
	const afterRelease = await gate.authorize(secondContext.context, request);
	assert.equal(afterRelease.allowed, true);
	afterRelease.release();
}

{
	const pi = createPi();
	const gate = createApprovalGate(pi, { concurrency: "queue" });
	const firstContext = createContext(["Allow once"]);
	const secondContext = createContext(["Allow once"]);
	const first = await gate.authorize(firstContext.context, request);
	assert.equal(first.allowed, true);

	let secondSettled = false;
	const secondPromise = gate.authorize(secondContext.context, request).then((result) => {
		secondSettled = true;
		return result;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(secondSettled, false);

	first.release();
	const second = await secondPromise;
	assert.equal(second.allowed, true);
	second.release();
}

{
	const pi = createPi();
	const gate = createApprovalGate(pi, { concurrency: "reject" });
	const brokenContext = {
		hasUI: true,
		ui: {
			async select() {
				throw new Error("UI closed");
			},
		},
	};
	await assert.rejects(gate.authorize(brokenContext, request), /UI closed/);

	const workingContext = createContext(["Allow once"]);
	const result = await gate.authorize(workingContext.context, request);
	assert.equal(result.allowed, true);
	result.release();
}

{
	const pi = createPi();
	const gate = createApprovalGate(pi);
	const ctx = createContext(["Allow once"]);
	const result = await gate.authorize(ctx.context, {
		...request,
		onStatus() {
			throw new Error("status renderer failed");
		},
	});
	assert.equal(result.allowed, true);
	result.release();
}

console.log("tool permission tests passed");
