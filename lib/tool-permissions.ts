export interface ApprovalContext {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
	};
}

export interface ApprovalLifecycle {
	on(event: "session_start", handler: () => unknown): void;
	on(event: "session_shutdown", handler: () => unknown): void;
	on(event: "agent_start", handler: () => unknown): void;
	on(event: "agent_end", handler: () => unknown): void;
}

export type ApprovalScope = "turn" | "time" | "session";
export type ApprovalConcurrency = "queue" | "reject";
export type ApprovalConfirmation = "approved-once" | "approved-with-grant" | "approval-grant";
export type ApprovalDenialKind = "busy" | "no-ui" | "user-denied";

export interface ApprovalGrant {
	key: string;
	scope: ApprovalScope;
	runId: number;
	expiresAt: number;
	label: string;
}

export interface ApprovalRequest {
	key: string;
	operation: string;
	scopeLabel: string;
	prompt: string;
	question: string;
	metadata?: Record<string, unknown>;
	onStatus?: (status: { type: "waiting" | "grant-used"; grant?: ApprovalGrant }) => void;
}

export interface ApprovalEvent {
	type: "prompted" | "approved" | "grant-used" | "denied" | "blocked";
	key: string;
	operation: string;
	metadata?: Record<string, unknown>;
	reason?: string;
	approvalScope?: "once" | ApprovalScope;
	approvalLabel?: string;
}

export interface ApprovalGateOptions {
	concurrency?: ApprovalConcurrency;
	durationMs?: number;
	now?: () => number;
	onEvent?: (event: ApprovalEvent) => void | Promise<void>;
}

export interface ApprovalAllowed {
	allowed: true;
	confirmation: ApprovalConfirmation;
	grant?: ApprovalGrant;
	release: () => void;
}

export interface ApprovalDenied {
	allowed: false;
	kind: ApprovalDenialKind;
	reason: string;
}

export type ApprovalDecision = ApprovalAllowed | ApprovalDenied;

export interface ApprovalGate {
	authorize(ctx: ApprovalContext, request: ApprovalRequest): Promise<ApprovalDecision>;
}

interface ApprovalLease {
	operation: string;
	release: () => void;
}

const DEFAULT_DURATION_MS = 5 * 60 * 1000;

function durationLabel(durationMs: number): string {
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		let unit = "minutes";
		if (minutes === 1) {
			unit = "minute";
		}
		return `${minutes} ${unit}`;
	}

	const seconds = Math.ceil(durationMs / 1000);
	let unit = "seconds";
	if (seconds === 1) {
		unit = "second";
	}
	return `${seconds} ${unit}`;
}

function approvalChoices(scopeLabel: string, duration: string) {
	return {
		once: "Allow once",
		turn: `Allow ${scopeLabel} this turn`,
		time: `Allow ${scopeLabel} for ${duration}`,
		session: `Allow ${scopeLabel} for this pi session`,
		deny: "Deny",
	} as const;
}

/** Format the shared approval scope explanation appended to domain-specific details. */
export function formatApprovalPrompt(request: ApprovalRequest, durationMs = DEFAULT_DURATION_MS): string {
	const duration = durationLabel(durationMs);
	return [
		request.prompt,
		"",
		"Approval scopes:",
		"- once: only this operation",
		`- this turn: confirmed operations for ${request.scopeLabel} until the current agent run ends`,
		`- ${duration}: confirmed operations for ${request.scopeLabel} until the timer expires`,
		`- this pi session: confirmed operations for ${request.scopeLabel} until the session ends or extensions reload`,
		"",
		request.question,
	].join("\n");
}

/**
 * Create a reusable permission gate for extension tools.
 *
 * The caller owns risk classification and performs the operation only after an
 * allowed result. Keep the returned lease until that operation has finished.
 */
export function createApprovalGate(pi: ApprovalLifecycle, options: ApprovalGateOptions = {}): ApprovalGate {
	const concurrency = options.concurrency ?? "reject";
	const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
	const now = options.now ?? Date.now;
	let currentAgentRunId = 0;
	let grants: ApprovalGrant[] = [];
	let activeLease: { token: symbol; operation: string } | undefined;
	let queueTail = Promise.resolve();

	async function emit(event: ApprovalEvent): Promise<void> {
		if (!options.onEvent) {
			return;
		}
		try {
			await options.onEvent(event);
		} catch {
			// Audit and telemetry failures must not change the permission decision.
		}
	}

	function emitStatus(
		request: ApprovalRequest,
		status: { type: "waiting" | "grant-used"; grant?: ApprovalGrant },
	): void {
		try {
			request.onStatus?.(status);
		} catch {
			// Display updates must not change the permission decision.
		}
	}

	function pruneGrants(): void {
		const timestamp = now();
		grants = grants.filter((grant) => {
			if (grant.scope === "session") {
				return true;
			}
			if (grant.scope === "turn") {
				return grant.runId === currentAgentRunId;
			}
			return grant.expiresAt > timestamp;
		});
	}

	function grantFor(key: string): ApprovalGrant | undefined {
		pruneGrants();
		return grants.find((grant) => grant.key === key);
	}

	function addGrant(scope: ApprovalScope, key: string): ApprovalGrant {
		let expiresAt = Number.MAX_SAFE_INTEGER;
		let label = `agent run ${currentAgentRunId}`;
		if (scope === "time") {
			expiresAt = now() + durationMs;
			label = durationLabel(durationMs);
		} else if (scope === "session") {
			label = "this pi session";
		}
		const grant: ApprovalGrant = {
			key,
			scope,
			runId: currentAgentRunId,
			expiresAt,
			label,
		};
		grants = grants.filter((existing) => !(existing.key === key && existing.scope === scope));
		grants.push(grant);
		return grant;
	}

	function releaseLease(token: symbol): void {
		if (activeLease?.token === token) {
			activeLease = undefined;
		}
	}

	async function acquireLease(operation: string): Promise<ApprovalLease | ApprovalDenied> {
		if (concurrency === "reject") {
			if (activeLease) {
				return {
					allowed: false,
					kind: "busy",
					reason: `another confirmed operation is already active: ${activeLease.operation}`,
				};
			}

			const token = Symbol(operation);
			activeLease = { token, operation };
			return { operation, release: () => releaseLease(token) };
		}

		let releaseQueue: () => void = () => {};
		const previous = queueTail;
		queueTail = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previous;

		const token = Symbol(operation);
		activeLease = { token, operation };
		return {
			operation,
			release: () => {
				releaseLease(token);
				releaseQueue();
			},
		};
	}

	async function authorize(ctx: ApprovalContext, request: ApprovalRequest): Promise<ApprovalDecision> {
		const lease = await acquireLease(request.operation);
		if ("allowed" in lease) {
			await emit({
				type: "blocked",
				key: request.key,
				operation: request.operation,
				metadata: request.metadata,
				reason: lease.reason,
			});
			return lease;
		}

		const existingGrant = grantFor(request.key);
		if (existingGrant) {
			emitStatus(request, { type: "grant-used", grant: existingGrant });
			await emit({
				type: "grant-used",
				key: request.key,
				operation: request.operation,
				metadata: request.metadata,
				approvalScope: existingGrant.scope,
				approvalLabel: existingGrant.label,
			});
			return {
				allowed: true,
				confirmation: "approval-grant",
				grant: existingGrant,
				release: lease.release,
			};
		}

		if (!ctx.hasUI) {
			lease.release();
			const reason = "confirmation required but no UI is available";
			await emit({
				type: "blocked",
				key: request.key,
				operation: request.operation,
				metadata: request.metadata,
				reason,
			});
			return { allowed: false, kind: "no-ui", reason };
		}

		emitStatus(request, { type: "waiting" });
		await emit({
			type: "prompted",
			key: request.key,
			operation: request.operation,
			metadata: request.metadata,
		});

		const labels = approvalChoices(request.scopeLabel, durationLabel(durationMs));
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(formatApprovalPrompt(request, durationMs), [
				labels.once,
				labels.turn,
				labels.time,
				labels.session,
				labels.deny,
			]);
		} catch (error) {
			lease.release();
			throw error;
		}

		if (!choice || choice === labels.deny) {
			lease.release();
			const reason = "blocked by user";
			await emit({
				type: "denied",
				key: request.key,
				operation: request.operation,
				metadata: request.metadata,
				reason,
			});
			return { allowed: false, kind: "user-denied", reason };
		}

		let grant: ApprovalGrant | undefined;
		if (choice === labels.turn) {
			grant = addGrant("turn", request.key);
		} else if (choice === labels.time) {
			grant = addGrant("time", request.key);
		} else if (choice === labels.session) {
			grant = addGrant("session", request.key);
		}

		await emit({
			type: "approved",
			key: request.key,
			operation: request.operation,
			metadata: request.metadata,
			approvalScope: grant?.scope ?? "once",
			approvalLabel: grant?.label ?? "once",
		});

		let confirmation: ApprovalConfirmation = "approved-once";
		if (grant) {
			confirmation = "approved-with-grant";
		}
		return {
			allowed: true,
			confirmation,
			grant,
			release: lease.release,
		};
	}

	pi.on("session_start", () => {
		grants = [];
		currentAgentRunId = 0;
	});
	pi.on("session_shutdown", () => {
		grants = [];
	});
	pi.on("agent_start", () => {
		currentAgentRunId += 1;
		pruneGrants();
	});
	pi.on("agent_end", () => {
		grants = grants.filter((grant) => grant.scope !== "turn" || grant.runId !== currentAgentRunId);
		pruneGrants();
	});

	return { authorize };
}
