import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAttentionAlerts } from "../lib/attention.ts";

const MAX_TITLE_LENGTH = 160;

type SessionStatus = "ready" | "working";

function sanitizeTitlePart(value: string): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function buildTitle(ctx: ExtensionContext, status: SessionStatus): string {
	const cwd = sanitizeTitlePart(path.basename(ctx.cwd));
	const sessionName = sanitizeTitlePart(ctx.sessionManager.getSessionName() ?? "");
	let statusLabel = "… working";
	if (status === "ready") {
		statusLabel = "● ready";
		if (readAttentionAlerts(ctx.sessionManager.getEntries()).some((alert) => !alert.acknowledged)) {
			statusLabel = "⚠ attention";
		}
	}

	let title = `${statusLabel} - π`;
	if (sessionName) {
		title += ` - ${sessionName}`;
	}
	if (cwd) {
		title += ` - ${cwd}`;
	}

	return title.slice(0, MAX_TITLE_LENGTH).trim();
}

export default function terminalTitleExtension(pi: ExtensionAPI) {
	let sessionGeneration = 0;
	let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
	let currentContext: ExtensionContext | undefined;

	pi.events.on("attention:changed", () => {
		if (currentContext) {
			let status: SessionStatus = "working";
			if (currentContext.isIdle()) {
				status = "ready";
			}
			scheduleTitle(currentContext, status);
		}
	});

	function clearPendingUpdate(): void {
		if (pendingUpdate) {
			clearTimeout(pendingUpdate);
			pendingUpdate = undefined;
		}
	}

	function setTitle(ctx: ExtensionContext, status: SessionStatus): void {
		clearPendingUpdate();
		ctx.ui.setTitle(buildTitle(ctx, status));
	}

	function scheduleTitle(ctx: ExtensionContext, status: SessionStatus): void {
		clearPendingUpdate();
		const generation = sessionGeneration;
		pendingUpdate = setTimeout(() => {
			pendingUpdate = undefined;
			if (generation !== sessionGeneration) {
				return;
			}
			ctx.ui.setTitle(buildTitle(ctx, status));
		}, 0);
	}

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		sessionGeneration += 1;
		// Pi sets its default title after session_start, so apply ours on the next tick.
		scheduleTitle(ctx, "ready");
	});

	pi.on("agent_start", async (_event, ctx) => {
		setTitle(ctx, "working");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		setTitle(ctx, "ready");
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		const status = ctx.isIdle() ? "ready" : "working";
		// The built-in title update handles the same event after extensions.
		scheduleTitle(ctx, status);
	});

	pi.on("session_shutdown", async () => {
		currentContext = undefined;
		sessionGeneration += 1;
		clearPendingUpdate();
	});
}
