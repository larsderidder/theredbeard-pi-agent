import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: registerNotify, buildKittyNotification, sendNotification } = await jiti.import("../extensions/notify.ts");
const { default: registerTitle } = await jiti.import("../extensions/terminal-title.ts");
const { ATTENTION_ENTRY, readAttentionAlerts, cleanNotificationText } = await jiti.import("../lib/attention.ts");
initTheme("dark", false);

const issue = {
	id: "production-health",
	title: "Production remains degraded",
	detail: "One replica is unavailable. Recovery requires operator intervention.",
};

function harness(manager = SessionManager.inMemory("/test/project")) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const notifications = [];
	const dismissed = [];
	const notices = [];
	const statuses = new Map();
	const titles = [];
	let idle = true;
	let deliveryFails = false;
	let deliveryGate;
	const pi = {
		events: new EventEmitter(),
		on(name, handler) {
			if (!handlers.has(name)) {
				handlers.set(name, []);
			}
			handlers.get(name).push(handler);
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		appendEntry(type, data) { manager.appendCustomEntry(type, data); },
		sendUserMessage() { throw new Error("Must not start another model turn"); },
	};
	const ctx = {
		cwd: "/test/project",
		mode: "tui",
		hasUI: true,
		sessionManager: manager,
		isIdle: () => idle,
		abort() { throw new Error("Must not interrupt work"); },
		shutdown() { throw new Error("Must not stop the session"); },
		ui: {
			setStatus(key, value) { statuses.set(key, value); },
			setTitle(value) { titles.push(value); },
			notify(text, level) { notices.push({ text, level }); },
			confirm() { throw new Error("Must not block on acknowledgment"); },
		},
	};
	registerNotify(pi, async (notification) => {
		if (deliveryGate) {
			await deliveryGate;
		}
		if (deliveryFails) {
			throw new Error("Desktop unavailable");
		}
		if (notification.close) {
			dismissed.push(notification.id);
			return;
		}
		notifications.push(structuredClone(notification));
	});
	registerTitle(pi);
	async function fire(name, event = {}) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, ctx));
		}
		return results;
	}
	async function start() {
		idle = false;
		await fire("agent_start");
	}
	async function settle() {
		idle = true;
		await fire("agent_settled");
	}
	async function tool(name, params) {
		return tools.get(name).execute("tool-call", params, undefined, undefined, ctx);
	}
	return {
		ctx, fire, start, settle, tool, commands, notifications, notices, statuses, titles, dismissed,
		alerts: () => readAttentionAlerts(manager.getEntries()),
		failDelivery(value) { deliveryFails = value; },
		delayDelivery(gate) { deliveryGate = gate; },
	};
}

// Reload or shutdown during OS delivery must not persist through an invalidated runtime.
{
	const h = harness();
	await h.fire("session_start");
	await h.tool("raise_attention", issue);
	let release;
	h.delayDelivery(new Promise((resolve) => { release = resolve; }));
	const settling = h.settle();
	await h.fire("session_shutdown");
	release();
	await settling;
	assert.equal(h.alerts()[0].notified, false);
}

// Updating prose while a popup is in flight cannot cause a repeat; a new escalation still can.
for (const escalate of [false, true]) {
	const h = harness();
	await h.tool("raise_attention", issue);
	let release;
	h.delayDelivery(new Promise((resolve) => { release = resolve; }));
	const settling = h.settle();
	const update = { ...issue, title: "Production recovery is still incomplete" };
	if (escalate) {
		update.escalation = "new-outage";
	}
	await h.tool("raise_attention", update);
	release();
	await settling;
	assert.equal(h.alerts()[0].notified, !escalate);
	h.delayDelivery(undefined);
	await h.settle();
	let expected = 1;
	if (escalate) {
		expected = 2;
	}
	assert.equal(h.notifications.filter((notice) => notice.critical).length, expected);
}

// A low-level run ending is not sufficient: queued work and retries can still follow.
{
	const h = harness();
	await h.fire("session_start");
	await h.start();
	const result = await h.tool("raise_attention", issue);
	assert.equal(result.terminate, undefined);
	assert.equal(result.isError, undefined);
	assert.equal(h.notifications.length, 0);
	assert.match(h.titles.at(-1), /working/);
	await h.fire("agent_end", { messages: [{ role: "assistant", content: "Continuing recovery" }] });
	assert.equal(h.notifications.length, 0);
	await h.start();
	await h.fire("agent_end", { messages: [{ role: "assistant", content: "Cannot complete recovery" }] });
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].critical, true);
	assert.match(h.notifications[0].title, /project/);
	assert.match(h.notifications[0].body, /Production remains degraded/);
	assert.doesNotMatch(h.notifications[0].body, /operator intervention/);
	assert.match(h.titles.at(-1), /attention/);
	assert.match(h.statuses.get("attention"), /needs attention/);
	assert.equal(h.alerts()[0].notified, true);

	// A new prompt or identical re-flag must not dismiss or repeatedly ping the issue.
	await h.start();
	await h.tool("raise_attention", issue);
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.match(h.titles.at(-1), /attention/);

	await h.commands.get("attention").handler("ack production-health", h.ctx);
	assert.equal(h.alerts()[0].acknowledged, true);
	assert.equal(h.statuses.get("attention"), undefined);
	assert.equal(h.dismissed.length, 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(h.titles.at(-1), /ready/);
	await h.commands.get("attention").handler("", h.ctx);
	assert.match(h.notices.at(-1).text, /acknowledged, unresolved/);
	assert.deepEqual(await h.fire("before_agent_start"), []);
	const status = await h.tool("list_attention", {});
	assert.match(status.content[0].text, /production-health/);
	assert.equal(status.details.alerts[0].acknowledged, true);

	// Updated wording or progress never rearms an acknowledged issue.
	await h.tool("raise_attention", { ...issue, title: "Production recovery is incomplete", detail: "Only the worker replica remains unavailable." });
	assert.equal(h.alerts()[0].acknowledged, true);
	assert.equal(h.alerts()[0].notified, true);
	await h.settle();
	assert.equal(h.notifications.filter((notice) => notice.critical).length, 1);

	// New evidence of deterioration requires an explicit, stable escalation ID.
	await h.tool("raise_attention", { ...issue, detail: "Both replicas are now unavailable.", escalation: "both-replicas-down" });
	await h.settle();
	assert.equal(h.notifications.filter((notice) => notice.critical).length, 2);
	assert.equal(h.alerts()[0].acknowledged, false);
	assert.deepEqual(h.alerts()[0].escalations, ["both-replicas-down"]);

	// Rewording the same escalation must not send another alert, even after acknowledgement.
	await h.commands.get("attention").handler("ack all", h.ctx);
	await h.tool("raise_attention", { ...issue, detail: "Neither replica is available.", escalation: "both-replicas-down" });
	await h.settle();
	assert.equal(h.notifications.filter((notice) => notice.critical).length, 2);
	assert.equal(h.alerts()[0].acknowledged, true);

	// A later deterioration does not erase the deduplication history of earlier events.
	await h.tool("raise_attention", { ...issue, detail: "The recovery snapshot is also unusable.", escalation: "recovery-snapshot-corrupt" });
	await h.settle();
	await h.commands.get("attention").handler("ack all", h.ctx);
	await h.tool("raise_attention", { ...issue, escalation: "both-replicas-down" });
	await h.settle();
	assert.equal(h.notifications.filter((notice) => notice.critical).length, 3);
	assert.equal(h.alerts()[0].acknowledged, true);
	h.alerts()[0].escalations.push("unpersisted-change");
	assert.deepEqual(h.alerts()[0].escalations, ["both-replicas-down", "recovery-snapshot-corrupt"]);
	await h.fire("session_shutdown");
}

// Recovery before settlement cancels the alert and preserves the ordinary completion preview.
{
	const h = harness();
	await h.start();
	await h.tool("raise_attention", issue);
	await h.tool("resolve_attention", { id: issue.id });
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "**Production recovered.**" }] }] });
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].critical, false);
	assert.match(h.notifications[0].body, /Production recovered/);
	assert.deepEqual(h.alerts(), []);
	assert.match(h.titles.at(-1), /ready/);
}

// Failed delivery stays pending and can be retried at the next genuine settlement.
{
	const h = harness();
	await h.tool("raise_attention", issue);
	h.failDelivery(true);
	await h.settle();
	assert.equal(h.alerts()[0].notified, false);
	assert.equal(h.notices.at(-1).level, "error");
	h.failDelivery(false);
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.alerts()[0].notified, true);
}

// Multiple findings are coalesced; acknowledging one cannot hide the others.
{
	const h = harness();
	await h.tool("raise_attention", issue);
	await h.tool("raise_attention", { ...issue, id: "data-loss", title: "Backup integrity is unverified" });
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0].body, /Production remains degraded/);
	assert.match(h.notifications[0].body, /1 more/);
	assert.doesNotMatch(h.notifications[0].body, /Backup integrity|operator intervention/);
	await h.commands.get("attention").handler("ack production-health", h.ctx);
	assert.match(h.statuses.get("attention"), /1 needs attention/);
	await h.commands.get("attention").handler("ack missing", h.ctx);
	assert.equal(h.notices.at(-1).level, "warning");
	await h.commands.get("attention").handler("ack all", h.ctx);
	assert.ok(h.alerts().every((alert) => alert.acknowledged));
	await assert.rejects(h.tool("resolve_attention", { id: "missing" }), /No attention record/);
	await assert.rejects(h.tool("raise_attention", { ...issue, title: "\x07\n " }), /meaningful/);
}

// Progress on an unacknowledged incident updates its record without another popup.
{
	const h = harness();
	await h.tool("raise_attention", issue);
	await h.settle();
	await h.tool("raise_attention", { ...issue, title: "Production worker remains unavailable", detail: "The API recovered; the worker still needs repair." });
	assert.equal(h.alerts()[0].notified, true);
	assert.equal(h.alerts()[0].acknowledged, false);
	await h.settle();
	assert.equal(h.notifications.length, 1);
	assert.match(h.statuses.get("attention"), /needs attention/);

	// A distinct new incident gets an alert without repeating old incident text.
	await h.tool("raise_attention", { ...issue, id: "backup-failed", title: "Production backup failed" });
	await h.settle();
	assert.equal(h.notifications.length, 2);
	assert.match(h.notifications[1].body, /Production backup failed/);
	assert.doesNotMatch(h.notifications[1].body, /worker remains unavailable/);
}

// Old persisted reminders stay on disk but no longer reach model context or multiply.
{
	const h = harness();
	const user = { role: "user", content: "Continue the task", timestamp: 1 };
	const reminder = { role: "custom", customType: "attention-state", content: "Old unresolved issue", display: false, timestamp: 2 };
	const unrelated = { ...reminder, customType: "other-extension" };
	const messages = [user, reminder, unrelated, { ...reminder, timestamp: 3 }];
	for (let run = 0; run < 3; run++) {
		assert.deepEqual(await h.fire("before_agent_start"), []);
		const [result] = await h.fire("context", { messages });
		assert.deepEqual(result.messages, [user, unrelated]);
	}
	assert.equal(messages.length, 4);
	assert.equal(h.ctx.sessionManager.getEntries().length, 0);
}

// Both ordinary and critical notifications stay short, including long project paths and Unicode.
{
	const h = harness();
	h.ctx.cwd = `/home/lars/workspace/${"日本語🚨".repeat(40)}`;
	const title = "Production still needs repair ".repeat(4).trim();
	const detail = "Long diagnostic text. ".repeat(40).trim();
	await h.tool("raise_attention", { ...issue, title, detail });
	await h.settle();
	const notice = h.notifications[0];
	assert.ok(visibleWidth(notice.title) <= 60);
	assert.ok(visibleWidth(notice.body) <= 140);
	assert.doesNotMatch(notice.title, /home\/lars\/workspace/);
	assert.match(notice.body, /\/attention/);
	assert.doesNotMatch(notice.body, /diagnostic text/);
	await h.commands.get("attention").handler("", h.ctx);
	assert.ok(h.notices.at(-1).text.includes(detail));
	await h.tool("resolve_attention", { id: issue.id });
	await h.fire("agent_end", { messages: [{ role: "assistant", content: "Recovered 🚨 日本語 ".repeat(50) }] });
	await h.settle();
	assert.ok(visibleWidth(h.notifications.at(-1).title) <= 60);
	assert.ok(visibleWidth(h.notifications.at(-1).body) <= 140);
}

// Existing records from before escalation IDs were introduced keep their seen/notified state.
{
	const manager = SessionManager.inMemory("/test/project");
	manager.appendCustomEntry(ATTENTION_ENTRY, [{ ...issue, acknowledged: true, notified: true }]);
	const h = harness(manager);
	await h.fire("session_start");
	await h.tool("raise_attention", { ...issue, title: "Repair is progressing" });
	await h.settle();
	assert.equal(h.alerts()[0].acknowledged, true);
	assert.equal(h.alerts()[0].notified, true);
	assert.equal(h.notifications.filter((notice) => notice.critical).length, 0);
	await h.fire("session_shutdown");
}

// Headless and RPC sessions must not write terminal escape sequences or send desktop popups.
for (const mode of ["print", "json", "rpc"]) {
	const h = harness();
	h.ctx.mode = mode;
	await h.tool("raise_attention", issue);
	await h.settle();
	assert.equal(h.notifications.length, 0);
	assert.equal(h.alerts()[0].notified, false);
}

// State survives a real on-disk session reopen and tree navigation does not erase a live risk.
{
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-notify-test-"));
	try {
		const manager = SessionManager.create(directory, directory);
		const root = manager.appendMessage({ role: "user", content: "Investigate", timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Investigating" }], api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: {} });
		const h = harness(manager);
		await h.tool("raise_attention", issue);
		await h.settle();
		const reopened = SessionManager.open(manager.getSessionFile());
		const resumed = harness(reopened);
		await resumed.fire("session_start");
		assert.equal(resumed.alerts()[0].notified, true);
		assert.match(resumed.statuses.get("attention"), /needs attention/);
		await resumed.settle();
		assert.equal(resumed.notifications.length, 0);
		reopened.branch(root);
		await resumed.fire("session_tree");
		assert.equal(resumed.alerts().length, 1);
		await resumed.commands.get("attention").handler("ack all", resumed.ctx);
		reopened.branch(root);
		await resumed.fire("session_tree");
		assert.equal(resumed.alerts()[0].acknowledged, true);
		await resumed.tool("raise_attention", { ...issue, title: "Awaiting worker recovery" });
		assert.equal(resumed.alerts()[0].acknowledged, true);
		assert.equal(resumed.alerts()[0].notified, true);
		await resumed.tool("raise_attention", { ...issue, escalation: "all-replicas-down", detail: "All replicas are down." });
		await resumed.settle();
		const afterReload = harness(SessionManager.open(manager.getSessionFile()));
		await afterReload.fire("session_start");
		await afterReload.tool("raise_attention", { ...issue, escalation: "all-replicas-down", detail: "Every replica is unavailable." });
		await afterReload.settle();
		assert.equal(afterReload.notifications.length, 0);
		await afterReload.fire("session_shutdown");
		await resumed.tool("resolve_attention", { id: issue.id });
		assert.deepEqual(readAttentionAlerts(SessionManager.open(manager.getSessionFile()).getEntries()), []);
		await resumed.fire("session_shutdown");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

// Kitty packets are safe, bounded, critical, persistent, and focus the originating window.
{
	const dangerous = "\x1b]52;c;clipboard\x07 <b>hello</b> 日本語🚨";
	const notification = { id: "pi-session", title: dangerous, body: dangerous.repeat(300), critical: true };
	const sequence = buildKittyNotification(notification);
	const packets = [...sequence.matchAll(/\x1b\]99;([^;]+);([^\x1b]*)\x1b\\/g)];
	assert.ok(packets.length > 2);
	assert.equal(packets.map((packet) => packet[0]).join(""), sequence);
	for (const packet of packets) {
		assert.match(packet[1], /a=focus:o=always:u=2:w=0/);
		assert.match(packet[1], /e=1/);
		assert.match(packet[2], /^[A-Za-z0-9+/=]+$/);
		assert.ok(packet[2].length <= 4096);
	}
	assert.ok(packets.slice(0, -1).every((packet) => packet[1].endsWith("d=0")));
	assert.match(packets.at(-1)[1], /d=1$/);
	for (const payload of ["title", "body"]) {
		const encoded = packets.filter((packet) => packet[1].includes(`p=${payload}:`)).map((packet) => packet[2]).join("");
		assert.equal(Buffer.from(encoded, "base64").toString("utf8"), cleanNotificationText(notification[payload]));
	}
	const wrapped = buildKittyNotification(notification, true);
	assert.equal(wrapped, `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`);
	const normal = buildKittyNotification({ ...notification, critical: false });
	assert.doesNotMatch(normal, /u=2|w=0/);
	assert.deepEqual(readAttentionAlerts([{ type: "custom", customType: ATTENTION_ENTRY, data: [{ id: "bad" }] }]), []);
}

// The manual delivery check must not create a real unresolved issue.
{
	const h = harness();
	await h.commands.get("attention").handler("test", h.ctx);
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0].title, /test \(not a real issue\)/);
	assert.deepEqual(h.alerts(), []);
	h.ctx.mode = "rpc";
	await h.commands.get("attention").handler("test", h.ctx);
	assert.equal(h.notifications.length, 1);
}

// Exercise the real transport with only OS boundaries replaced, never send a test popup here.
{
	const originalKittyId = process.env.KITTY_WINDOW_ID;
	const originalTmux = process.env.TMUX;
	const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const writes = [];
	const processes = [];
	const writeMock = mock.method(process.stdout, "write", (data) => {
		writes.push(data);
		return true;
	});
	const execMock = mock.method(childProcess, "execFile", (file, args, options, callback) => {
		processes.push({ file, args, options });
		callback(null);
	});
	syncBuiltinESMExports();
	try {
		process.env.KITTY_WINDOW_ID = "test-window";
		delete process.env.TMUX;
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const notification = { id: "test-session", title: "--title", body: "<b>Risk & impact</b>", critical: true };
		await sendNotification(notification);
		assert.equal(writes.length, 1);
		assert.match(writes[0], /a=focus:o=always:u=2:w=0/);
		assert.equal(processes.length, 0);
		await sendNotification({ ...notification, close: true });
		assert.equal(writes[1], "\x1b]99;i=test-session:p=close;\x1b\\");
		await sendNotification({ ...notification, title: "日本語🚨".repeat(40), body: "Long 🚨 message ".repeat(50) });
		const bounded = [...writes.at(-1).matchAll(/\x1b\]99;([^;]+);([^\x1b]*)\x1b\\/g)];
		assert.equal(bounded.length, 2);
		for (const packet of bounded) {
			let width = 140;
			if (packet[1].includes("p=title:")) {
				width = 60;
			}
			assert.ok(visibleWidth(Buffer.from(packet[2], "base64").toString("utf8")) <= width);
		}
		if (process.platform === "linux") {
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
			await sendNotification(notification);
			assert.equal(processes.length, 1);
			assert.equal(processes[0].file, "notify-send");
			assert.deepEqual(processes[0].args, ["--app-name=pi", "--urgency=critical", "--expire-time=0", "--", "--title", "&lt;b&gt;Risk &amp; impact&lt;/b&gt;"]);
			assert.equal(processes[0].options.timeout, 5000);
			await sendNotification({ ...notification, close: true });
			assert.equal(processes.length, 1);
		}
	} finally {
		writeMock.mock.restore();
		execMock.mock.restore();
		syncBuiltinESMExports();
		if (originalKittyId === undefined) {
			delete process.env.KITTY_WINDOW_ID;
		} else {
			process.env.KITTY_WINDOW_ID = originalKittyId;
		}
		if (originalTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = originalTmux;
		}
		if (ttyDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		} else {
			delete process.stdout.isTTY;
		}
	}
}

console.log("Notification tests passed.");
