import { execFileSync } from "node:child_process";
import { existsSync, openSync, readFileSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type PeerScope = "repo" | "cwd" | "all";

interface SessionPeerParams {
  scope?: PeerScope;
  cwd?: string;
  limit?: number;
  sinceHours?: number;
  runningOnly?: boolean;
  includeSelf?: boolean;
}

interface SessionRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  cwd: string;
  repoRootsJson: string;
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  firstUserPrompt: string | null;
  handoffGoal: string | null;
  handoffNextTask: string | null;
}

interface TailEvent {
  ts: string;
  text: string;
}

interface PeerActivity {
  lastUser?: TailEvent;
  lastAssistant?: TailEvent;
  lastTool?: TailEvent;
  lastBash?: TailEvent;
  lastEventAt?: string;
}

interface SessionPeer {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  fileModifiedAt?: string;
  messageCount: number;
  firstUserPrompt?: string;
  handoffGoal?: string;
  handoffNextTask?: string;
  running: boolean;
  activity: PeerActivity;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_SINCE_HOURS = 48;
const MAX_LIMIT = 25;
const RECENT_SESSION_SCAN_LIMIT = 250;
const TAIL_BYTES = 512 * 1024;
const TEXT_LIMIT = 240;
const TOOL_TEXT_LIMIT = 180;

export default function sessionPeersExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_peers",
    label: "Session Peers",
    description: "Poll recent activity from other Pi agents in the current directory or repo, with timestamps",
    promptSnippet:
      "List what other Pi agents in this directory or repo did last, with session ids and timestamps",
    promptGuidelines: [
      "Use session_peers when coordinating with other active agents or catching up on parallel worker sessions.",
      "session_peers defaults to the current git repo when available and excludes the current session.",
      "Use the returned session ids with session_ask if you need deeper details from one peer session.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([
          Type.Literal("repo"),
          Type.Literal("cwd"),
          Type.Literal("all"),
        ], {
          description: "Search scope. repo uses the current git repo when available. cwd uses this directory tree. all ignores location.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Directory to use as the scope root. Defaults to the current session cwd." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum peer sessions to return, default 8, max 25." })),
      sinceHours: Type.Optional(
        Type.Number({ description: "Only include sessions updated in the last N hours, default 48. Use 0 for no time filter." }),
      ),
      runningOnly: Type.Optional(
        Type.Boolean({ description: "Only include sessions that currently have a pi bridge socket." }),
      ),
      includeSelf: Type.Optional(Type.Boolean({ description: "Include the current session in the result." })),
    }),
    async execute(_toolCallId, params: SessionPeerParams, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Polling peer sessions..." }], details: {} });

      const result = pollPeerSessions(params, ctx.cwd, ctx.sessionManager.getSessionId());
      return {
        content: [{ type: "text", text: formatPeerSessions(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("session-peers", {
    description: "Show recent activity from other Pi sessions in this directory or repo",
    handler: async (args, ctx) => {
      const limit = parseLimitArg(args);
      const result = pollPeerSessions({ limit }, ctx.cwd, ctx.sessionManager.getSessionId());
      pi.sendMessage({
        customType: "session-peers",
        content: formatPeerSessions(result),
        display: true,
        details: result,
      });
    },
  });
}

function pollPeerSessions(params: SessionPeerParams, currentCwd: string, currentSessionId?: string) {
  const indexPath = getIndexPath();
  const scope = params.scope ?? "repo";
  const rootCwd = path.resolve(params.cwd ?? currentCwd);
  const repoRoot = scope === "repo" ? findGitRoot(rootCwd) : undefined;
  const limit = clampLimit(params.limit);
  const sinceHours = params.sinceHours ?? DEFAULT_SINCE_HOURS;
  const sinceIso = sinceHours > 0 ? new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString() : undefined;

  if (!existsSync(indexPath)) {
    return {
      error: `Session index missing at ${indexPath}. Run /session-index and rebuild it first.`,
      indexPath,
      scope,
      rootCwd,
      repoRoot,
      peers: [] as SessionPeer[],
    };
  }

  const rows = readRecentSessionRows(indexPath, sinceIso, currentSessionId, params.includeSelf === true);
  const peers = rows
    .map((row) => buildPeer(row))
    .filter((peer): peer is SessionPeer => peer !== undefined)
    .filter((peer) => isInScope(peer, scope, rootCwd, repoRoot))
    .filter((peer) => !params.runningOnly || peer.running)
    .sort(comparePeers)
    .slice(0, limit);

  return {
    indexPath,
    scope,
    rootCwd,
    repoRoot,
    sinceHours,
    runningOnly: params.runningOnly === true,
    includeSelf: params.includeSelf === true,
    peers,
  };
}

function readRecentSessionRows(
  indexPath: string,
  sinceIso: string | undefined,
  currentSessionId: string | undefined,
  includeSelf: boolean,
): SessionRow[] {
  const Database = loadBetterSqlite3();
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `
          SELECT
            session_id as sessionId,
            session_path as sessionPath,
            session_name as sessionName,
            first_user_prompt as firstUserPrompt,
            cwd,
            repo_roots_json as repoRootsJson,
            created_ts as startedAt,
            modified_ts as modifiedAt,
            message_count as messageCount,
            handoff_goal as handoffGoal,
            handoff_next_task as handoffNextTask
          FROM sessions
          WHERE (? IS NULL OR modified_ts >= ?)
            AND (? = 1 OR session_id != ?)
          ORDER BY modified_ts DESC
          LIMIT ?
        `,
      )
      .all(
        sinceIso ?? null,
        sinceIso ?? null,
        includeSelf ? 1 : 0,
        currentSessionId ?? "",
        RECENT_SESSION_SCAN_LIMIT,
      ) as SessionRow[];
  } finally {
    db.close();
  }
}

function loadBetterSqlite3(): any {
  const requireFromPiNpm = createRequire(path.join(os.homedir(), ".pi", "agent", "npm", "package.json"));
  return requireFromPiNpm("better-sqlite3");
}

function buildPeer(row: SessionRow): SessionPeer | undefined {
  const repoRoots = parseRepoRoots(row.repoRootsJson);
  const fileModifiedAt = getFileModifiedAt(row.sessionPath);
  const activity = readSessionActivity(row.sessionPath);

  return {
    sessionId: row.sessionId,
    sessionName: row.sessionName,
    sessionPath: row.sessionPath,
    cwd: row.cwd,
    repoRoots,
    startedAt: row.startedAt,
    modifiedAt: activity.lastEventAt ?? fileModifiedAt ?? row.modifiedAt,
    fileModifiedAt,
    messageCount: row.messageCount,
    firstUserPrompt: row.firstUserPrompt ?? undefined,
    handoffGoal: row.handoffGoal ?? undefined,
    handoffNextTask: row.handoffNextTask ?? undefined,
    running: isSessionRunning(row.sessionId),
    activity,
  };
}

function readSessionActivity(sessionPath: string): PeerActivity {
  const activity: PeerActivity = {};
  for (const entry of readTailJsonl(sessionPath)) {
    const ts = normalizeEntryTimestamp(entry);
    if (ts) activity.lastEventAt = maxIso(activity.lastEventAt, ts);

    if (entry.type === "message" && entry.message) {
      readMessageActivity(entry.message, ts, activity);
      continue;
    }

    if (entry.type === "custom_message") {
      const text = contentToText(entry.content);
      if (text) activity.lastAssistant = { ts, text: truncateOneLine(text, TEXT_LIMIT) };
    }
  }
  return activity;
}

function readMessageActivity(message: any, fallbackTs: string, activity: PeerActivity): void {
  const ts = normalizeMessageTimestamp(message, fallbackTs);
  switch (message.role) {
    case "user": {
      const text = contentToText(message.content);
      if (text) activity.lastUser = { ts, text: truncateOneLine(text, TEXT_LIMIT) };
      return;
    }
    case "assistant": {
      const text = contentToText(message.content);
      if (text) activity.lastAssistant = { ts, text: truncateOneLine(text, TEXT_LIMIT) };
      const toolCalls = toolCallsToText(message.content);
      if (toolCalls) activity.lastTool = { ts, text: toolCalls };
      return;
    }
    case "toolResult": {
      const text = `${message.toolName ?? "tool"}: ${truncateOneLine(contentToText(message.content), TOOL_TEXT_LIMIT)}`;
      activity.lastTool = { ts, text };
      return;
    }
    case "bashExecution": {
      const command = truncateOneLine(String(message.command ?? ""), TOOL_TEXT_LIMIT);
      activity.lastBash = { ts, text: command };
      return;
    }
  }
}

function readTailJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return [];

  const fd = openSync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift();

    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  } finally {
    closeSync(fd);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolCallsToText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const calls = content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "toolCall")
    .map((part) => formatToolCall(String(part.name ?? "tool"), part.arguments));

  return calls.slice(-3).join("; ");
}

function formatToolCall(name: string, args: unknown): string {
  const payload = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const pathValue = typeof payload.path === "string" ? payload.path : undefined;
  if (pathValue) return `${name} ${pathValue}`;

  if (name === "bash" && typeof payload.command === "string") {
    return `bash ${truncateOneLine(payload.command, TOOL_TEXT_LIMIT)}`;
  }

  if (name === "edit" && typeof payload.path === "string") {
    return `edit ${payload.path}`;
  }

  return name;
}

function normalizeEntryTimestamp(entry: any): string {
  if (typeof entry.timestamp === "string") return entry.timestamp;
  if (entry.message) return normalizeMessageTimestamp(entry.message, new Date().toISOString());
  return new Date().toISOString();
}

function normalizeMessageTimestamp(message: any, fallback: string): string {
  if (typeof message.timestamp === "number") return new Date(message.timestamp).toISOString();
  if (typeof message.timestamp === "string") return message.timestamp;
  return fallback;
}

function parseRepoRoots(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function isInScope(peer: SessionPeer, scope: PeerScope, rootCwd: string, repoRoot: string | undefined): boolean {
  if (scope === "all") return true;
  if (scope === "repo" && repoRoot) {
    return peer.repoRoots.some((root) => samePath(root, repoRoot)) || isPathInside(peer.cwd, repoRoot);
  }
  return samePath(peer.cwd, rootCwd) || isPathInside(peer.cwd, rootCwd);
}

function comparePeers(a: SessionPeer, b: SessionPeer): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  return b.modifiedAt.localeCompare(a.modifiedAt);
}

function findGitRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return path.resolve(output.trim());
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSessionRunning(sessionId: string): boolean {
  const dir = path.join(os.homedir(), ".pi", "agent", "sockets");
  try {
    return readdirSync(dir).some((entry) => entry.startsWith(`${sessionId}-`) && entry.endsWith(".sock"));
  } catch {
    return false;
  }
}

function getFileModifiedAt(filePath: string): string | undefined {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function getIndexPath(): string {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const dir = settings?.sessions?.index?.dir;
    if (typeof dir === "string" && dir.trim()) {
      return path.join(expandHome(dir.trim()), "index.sqlite");
    }
  } catch {
    // Fall back to the pi-sessions default.
  }
  return path.join(os.homedir(), ".pi", "agent", "pi-sessions", "index.sqlite");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function formatPeerSessions(result: ReturnType<typeof pollPeerSessions>): string {
  if ("error" in result) return result.error;

  const scopeLabel = result.scope === "repo" && result.repoRoot ? `repo ${result.repoRoot}` : `${result.scope} ${result.rootCwd}`;
  const lines = [
    `Session peers for ${scopeLabel}`,
    `index: ${result.indexPath}`,
    `filter: last ${result.sinceHours}h${result.runningOnly ? ", running only" : ""}`,
    "",
  ];

  if (result.peers.length === 0) {
    lines.push("No peer sessions found.");
    return lines.join("\n");
  }

  result.peers.forEach((peer, index) => {
    const title = peer.sessionName || peer.handoffNextTask || peer.firstUserPrompt || "unnamed";
    lines.push(`${index + 1}. ${peer.running ? "running" : "recent"} ${shortId(peer.sessionId)}  ${truncateOneLine(title, 96)}`);
    lines.push(`   session: ${peer.sessionId}`);
    lines.push(`   updated: ${formatTimestamp(peer.modifiedAt)} (${formatAge(peer.modifiedAt)})`);
    lines.push(`   cwd: ${peer.cwd}`);
    appendEventLine(lines, "last user", peer.activity.lastUser);
    appendEventLine(lines, "last action", peer.activity.lastTool ?? peer.activity.lastBash);
    appendEventLine(lines, "last response", peer.activity.lastAssistant);
    if (peer.handoffNextTask) lines.push(`   next task: ${truncateOneLine(peer.handoffNextTask, TEXT_LIMIT)}`);
  });

  return lines.join("\n");
}

function appendEventLine(lines: string[], label: string, event: TailEvent | undefined): void {
  if (!event?.text) return;
  lines.push(`   ${label} ${formatTimeOnly(event.ts)}: ${event.text}`);
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatTimeOnly(iso: string): string {
  return iso.slice(11, 19) || iso;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateOneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function maxIso(a: string | undefined, b: string): string {
  return !a || b > a ? b : a;
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function parseLimitArg(args: string): number | undefined {
  const value = Number(args.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
