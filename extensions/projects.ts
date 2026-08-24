/**
 * Persistent projects for work that spans todos and Pi sessions.
 *
 * Projects are stored as markdown files in .pi/projects. The JSON header keeps
 * searchable metadata and session references, while the markdown body holds the
 * broader project description.
 */
import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

const PROJECT_DIR_NAME = ".pi/projects";
const PROJECT_PATH_ENV = "PI_PROJECT_PATH";
const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const PROJECT_ID_PREFIX = "PROJECT-";
const PROJECT_ID_PATTERN = /^[a-f0-9]{8}$/i;
const PROJECT_WORK_ENTRY = "project-work";
const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
const LOCK_TTL_MS = 30 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_TAG_LENGTH = 64;
const MAX_TAGS = 50;
const MAX_BODY_LENGTH = 200_000;
const MAX_PROJECT_FILE_BYTES = 2_000_000;

interface ProjectSessionWork {
	session_id: string;
	session_file?: string;
	session_name?: string;
	cwd: string;
	first_worked_at: string;
	last_worked_at: string;
}

interface ProjectFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	updated_at: string;
	sessions: ProjectSessionWork[];
}

interface ProjectRecord extends ProjectFrontMatter {
	body: string;
}

interface ProjectSummary extends Omit<ProjectFrontMatter, "sessions"> {
	session_count: number;
	last_worked_at?: string;
}

interface RelatedTodo {
	id: string;
	title: string;
	status: string;
}

interface LockInfo {
	pid: number;
	session?: string;
	created_at: string;
}

type ProjectAction =
	| "list"
	| "list-all"
	| "get"
	| "create"
	| "update"
	| "append"
	| "delete"
	| "mark-worked"
	| "sessions";

type ProjectToolDetails =
	| { action: "list" | "list-all"; projects: ProjectSummary[]; error?: string }
	| {
			action: "get" | "create" | "update" | "append" | "delete" | "mark-worked";
			project?: ProjectRecord;
			relatedTodos?: RelatedTodo[];
			error?: string;
	  }
	| { action: "sessions"; project?: ProjectFrontMatter; error?: string };

const ProjectParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"create",
		"update",
		"append",
		"delete",
		"mark-worked",
		"sessions",
	] as const),
	id: Type.Optional(Type.String({ description: "Project id (PROJECT-<hex> or raw hex filename)" })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH, description: "Short project name" })),
	status: Type.Optional(StringEnum(PROJECT_STATUSES)),
	tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: MAX_TAG_LENGTH }), {
			maxItems: MAX_TAGS,
			description: "Tags that replace the current project tags",
		}),
	),
	add_tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: MAX_TAG_LENGTH }), {
			maxItems: MAX_TAGS,
			description: "Tags to add without replacing existing tags",
		}),
	),
	remove_tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: MAX_TAG_LENGTH }), {
			maxItems: MAX_TAGS,
			description: "Tags to remove",
		}),
	),
	body: Type.Optional(
		Type.String({ maxLength: MAX_BODY_LENGTH, description: "Broad markdown description. Update replaces; append adds." }),
	),
});

function formatProjectId(id: string): string {
	return `${PROJECT_ID_PREFIX}${normalizeProjectId(id)}`;
}

function normalizeProjectId(id: string): string {
	let normalized = id.trim();
	if (normalized.startsWith("#")) {
		normalized = normalized.slice(1);
	}
	if (normalized.toUpperCase().startsWith(PROJECT_ID_PREFIX)) {
		normalized = normalized.slice(PROJECT_ID_PREFIX.length);
	}
	return normalized.toLowerCase();
}

// ASVS 2.2.1: project identifiers use a strict allow list before they affect file access.
function validateProjectId(id: string): { id: string } | { error: string } {
	const normalized = normalizeProjectId(id);
	if (!PROJECT_ID_PATTERN.test(normalized)) {
		return { error: "Invalid project id. Expected PROJECT-<hex>." };
	}
	return { id: normalized };
}

function normalizeTitle(title: string): { title: string } | { error: string } {
	const normalized = title.trim();
	if (!normalized) {
		return { error: "Project title cannot be empty." };
	}
	if (normalized.length > MAX_TITLE_LENGTH) {
		return { error: `Project title cannot exceed ${MAX_TITLE_LENGTH} characters.` };
	}
	return { title: normalized };
}

function normalizeTags(tags: string[]): { tags: string[] } | { error: string } {
	if (tags.length > MAX_TAGS) {
		return { error: `A project can have at most ${MAX_TAGS} tags.` };
	}

	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawTag of tags) {
		const tag = rawTag.trim();
		if (!tag || tag.length > MAX_TAG_LENGTH) {
			return { error: `Tags must contain 1 to ${MAX_TAG_LENGTH} characters.` };
		}
		const key = tag.toLowerCase();
		if (!seen.has(key)) {
			normalized.push(tag);
			seen.add(key);
		}
	}
	return { tags: normalized };
}

function isProjectClosed(status: string): boolean {
	return status === "done" || status === "archived";
}

function getProjectsDir(cwd: string): string {
	const overridePath = process.env[PROJECT_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, PROJECT_DIR_NAME);
}

function getProjectsDirLabel(cwd: string): string {
	const overridePath = process.env[PROJECT_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return PROJECT_DIR_NAME;
}

function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

// ASVS 5.3.2: filenames are derived only from validated internal project ids.
function getProjectPath(projectsDir: string, id: string): string {
	return path.join(projectsDir, `${id}.md`);
}

function getLockPath(projectsDir: string, id: string): string {
	return path.join(projectsDir, `${id}.lock`);
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index += 1) {
		const character = content[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === "\"") {
				inString = false;
			}
			continue;
		}
		if (character === "\"") {
			inString = true;
			continue;
		}
		if (character === "{") {
			depth += 1;
			continue;
		}
		if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}
	const end = findJsonObjectEnd(content);
	if (end < 0) {
		return { frontMatter: "", body: content };
	}
	return {
		frontMatter: content.slice(0, end + 1),
		body: content.slice(end + 1).replace(/^\r?\n+/, ""),
	};
}

function parseSessionWork(value: unknown): ProjectSessionWork[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const sessions: ProjectSessionWork[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const candidate = item as Partial<ProjectSessionWork>;
		if (typeof candidate.session_id !== "string" || !candidate.session_id.trim()) {
			continue;
		}
		if (typeof candidate.cwd !== "string") {
			continue;
		}
		if (typeof candidate.first_worked_at !== "string" || typeof candidate.last_worked_at !== "string") {
			continue;
		}
		const session: ProjectSessionWork = {
			session_id: candidate.session_id,
			cwd: candidate.cwd,
			first_worked_at: candidate.first_worked_at,
			last_worked_at: candidate.last_worked_at,
		};
		if (typeof candidate.session_file === "string" && candidate.session_file) {
			session.session_file = candidate.session_file;
		}
		if (typeof candidate.session_name === "string" && candidate.session_name) {
			session.session_name = candidate.session_name;
		}
		sessions.push(session);
	}
	return sessions;
}

function parseProjectContent(content: string, idFallback: string): ProjectRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	let parsed: Partial<ProjectFrontMatter> = {};
	try {
		const value = JSON.parse(frontMatter) as unknown;
		if (value && typeof value === "object") {
			parsed = value as Partial<ProjectFrontMatter>;
		}
	} catch {
		parsed = {};
	}

	let id = idFallback;
	if (typeof parsed.id === "string" && PROJECT_ID_PATTERN.test(parsed.id)) {
		id = parsed.id.toLowerCase();
	}
	let title = "";
	if (typeof parsed.title === "string") {
		title = parsed.title.slice(0, MAX_TITLE_LENGTH);
	}
	let status = "active";
	if (typeof parsed.status === "string" && PROJECT_STATUSES.includes(parsed.status as (typeof PROJECT_STATUSES)[number])) {
		status = parsed.status;
	}
	let tags: string[] = [];
	if (Array.isArray(parsed.tags)) {
		const stringTags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		const normalized = normalizeTags(stringTags.slice(0, MAX_TAGS));
		if ("tags" in normalized) {
			tags = normalized.tags;
		}
	}

	let createdAt = "";
	if (typeof parsed.created_at === "string") {
		createdAt = parsed.created_at;
	}
	let updatedAt = "";
	if (typeof parsed.updated_at === "string") {
		updatedAt = parsed.updated_at;
	}
	return {
		id,
		title,
		tags,
		status,
		created_at: createdAt,
		updated_at: updatedAt,
		sessions: parseSessionWork(parsed.sessions),
		body,
	};
}

function serializeProject(project: ProjectRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: project.id,
			title: project.title,
			tags: project.tags,
			status: project.status,
			created_at: project.created_at,
			updated_at: project.updated_at,
			sessions: project.sessions,
		},
		null,
		2,
	);
	const body = project.body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!body) {
		return `${frontMatter}\n`;
	}
	return `${frontMatter}\n\n${body}\n`;
}

async function ensureProjectsDir(projectsDir: string): Promise<void> {
	await fs.mkdir(projectsDir, { recursive: true, mode: 0o700 });
}

async function readProjectFile(filePath: string, idFallback: string): Promise<ProjectRecord> {
	const stats = await fs.stat(filePath);
	if (stats.size > MAX_PROJECT_FILE_BYTES) {
		throw new Error("Project file exceeds the 2 MB storage limit.");
	}
	const content = await fs.readFile(filePath, "utf8");
	return parseProjectContent(content, idFallback);
}

async function writeProjectFile(filePath: string, project: ProjectRecord): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temporaryPath, serializeProject(project), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.unlink(temporaryPath).catch(() => undefined);
	}
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireProjectLock(
	projectsDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	await ensureProjectsDir(projectsDir);
	const lockPath = getLockPath(projectsDir, id);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			try {
				const info: LockInfo = {
					pid: process.pid,
					created_at: new Date().toISOString(),
				};
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (sessionFile) {
					info.session = sessionFile;
				}
				await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			} catch {
				await fs.unlink(lockPath).catch(() => undefined);
				return { error: "Could not initialize the project lock." };
			} finally {
				await handle.close().catch(() => undefined);
			}
			return async () => {
				await fs.unlink(lockPath).catch(() => undefined);
			};
		} catch (error) {
			let code = "";
			if (error && typeof error === "object" && "code" in error) {
				code = String(error.code);
			}
			if (code !== "EEXIST") {
				return { error: "Could not lock the project for writing." };
			}
		}

		const stats = await fs.stat(lockPath).catch(() => null);
		const stale = !stats || Date.now() - stats.mtimeMs > LOCK_TTL_MS;
		if (!stale) {
			const info = await readLockInfo(lockPath);
			let owner = "another session";
			if (info?.session) {
				owner = info.session;
			}
			return { error: `Project ${formatProjectId(id)} is locked by ${owner}.` };
		}
		if (!ctx.hasUI) {
			return { error: `Project ${formatProjectId(id)} has a stale lock. Rerun interactively to remove it.` };
		}
		const confirmed = await ctx.ui.confirm(
			"Project locked",
			`Project ${formatProjectId(id)} has a stale lock. Remove it?`,
		);
		if (!confirmed) {
			return { error: `Project ${formatProjectId(id)} remains locked.` };
		}
		await fs.unlink(lockPath).catch(() => undefined);
	}
	return { error: `Could not lock project ${formatProjectId(id)}.` };
}

// ASVS 15.4.1: Pi serializes same-process mutations; the lock file coordinates other processes.
async function withProjectLock<T>(
	projectsDir: string,
	id: string,
	ctx: ExtensionContext,
	operation: () => Promise<T>,
): Promise<T | { error: string }> {
	const projectPath = getProjectPath(projectsDir, id);
	return withFileMutationQueue(projectPath, async () => {
		const lock = await acquireProjectLock(projectsDir, id, ctx);
		if (typeof lock === "object") {
			return lock;
		}
		try {
			return await operation();
		} finally {
			await lock();
		}
	});
}

async function generateProjectId(projectsDir: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		if (!existsSync(getProjectPath(projectsDir, id)) && !existsSync(getLockPath(projectsDir, id))) {
			return id;
		}
	}
	throw new Error("Could not allocate a project id.");
}

function toProjectSummary(project: ProjectFrontMatter): ProjectSummary {
	let lastWorkedAt: string | undefined;
	for (const session of project.sessions) {
		if (!lastWorkedAt || session.last_worked_at > lastWorkedAt) {
			lastWorkedAt = session.last_worked_at;
		}
	}
	const summary: ProjectSummary = {
		id: project.id,
		title: project.title,
		tags: project.tags,
		status: project.status,
		created_at: project.created_at,
		updated_at: project.updated_at,
		session_count: project.sessions.length,
	};
	if (lastWorkedAt) {
		summary.last_worked_at = lastWorkedAt;
	}
	return summary;
}

function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
	return [...projects].sort((left, right) => {
		const leftClosed = isProjectClosed(left.status);
		const rightClosed = isProjectClosed(right.status);
		if (leftClosed !== rightClosed) {
			if (leftClosed) {
				return 1;
			}
			return -1;
		}
		return right.updated_at.localeCompare(left.updated_at);
	});
}

async function listProjects(projectsDir: string): Promise<ProjectSummary[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(projectsDir);
	} catch {
		return [];
	}

	const projects: ProjectSummary[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const id = entry.slice(0, -3);
		if (!PROJECT_ID_PATTERN.test(id)) {
			continue;
		}
		try {
			const project = await readProjectFile(getProjectPath(projectsDir, id), id);
			projects.push(toProjectSummary(project));
		} catch {
			// An invalid project file is skipped without breaking access to the remaining projects.
		}
	}
	return sortProjects(projects);
}

function listProjectsSync(projectsDir: string): ProjectSummary[] {
	let entries: string[];
	try {
		entries = readdirSync(projectsDir);
	} catch {
		return [];
	}
	const projects: ProjectSummary[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const id = entry.slice(0, -3);
		if (!PROJECT_ID_PATTERN.test(id)) {
			continue;
		}
		try {
			const content = readFileSync(getProjectPath(projectsDir, id), "utf8");
			projects.push(toProjectSummary(parseProjectContent(content, id)));
		} catch {
			// Keep completion available when one project file is unreadable.
		}
	}
	return sortProjects(projects);
}

function upsertSessionWork(sessions: ProjectSessionWork[], session: ProjectSessionWork): void {
	const existing = sessions.find((candidate) => candidate.session_id === session.session_id);
	if (!existing) {
		sessions.push(session);
		return;
	}
	existing.last_worked_at = session.last_worked_at;
	existing.cwd = session.cwd;
	if (session.session_file) {
		existing.session_file = session.session_file;
	}
	if (session.session_name) {
		existing.session_name = session.session_name;
	}
}

function buildSessionWork(pi: ExtensionAPI, ctx: ExtensionContext, workedAt: string): ProjectSessionWork {
	const session: ProjectSessionWork = {
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		first_worked_at: workedAt,
		last_worked_at: workedAt,
	};
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		session.session_file = sessionFile;
	}
	const sessionName = pi.getSessionName();
	if (sessionName) {
		session.session_name = sessionName;
	}
	return session;
}

async function readProjectById(
	projectsDir: string,
	rawId: string,
): Promise<ProjectRecord | { error: string }> {
	const validated = validateProjectId(rawId);
	if ("error" in validated) {
		return validated;
	}
	try {
		return await readProjectFile(getProjectPath(projectsDir, validated.id), validated.id);
	} catch (error) {
		let code = "";
		if (error && typeof error === "object" && "code" in error) {
			code = String(error.code);
		}
		if (code === "ENOENT") {
			return { error: `Project ${formatProjectId(validated.id)} not found.` };
		}
		return { error: `Could not read project ${formatProjectId(validated.id)}.` };
	}
}

async function listRelatedTodos(todosDir: string, projectId: string): Promise<RelatedTodo[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}
	const todos: RelatedTodo[] = [];
	for (const entry of entries) {
		if (!/^[a-f0-9]{8}\.md$/i.test(entry)) {
			continue;
		}
		try {
			const content = await fs.readFile(path.join(todosDir, entry), "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = JSON.parse(frontMatter) as Record<string, unknown>;
			if (typeof parsed.project_id !== "string" || normalizeProjectId(parsed.project_id) !== projectId) {
				continue;
			}
			let title = "";
			if (typeof parsed.title === "string") {
				title = parsed.title;
			}
			let status = "open";
			if (typeof parsed.status === "string") {
				status = parsed.status;
			}
			todos.push({
				id: `TODO-${entry.slice(0, -3).toLowerCase()}`,
				title,
				status,
			});
		} catch {
			// Ignore malformed todo files while preserving the project itself.
		}
	}
	return todos;
}

function formatToolOutput(text: string, sourcePath?: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) {
		return text;
	}
	let suffix = "\n\n[Output truncated.";
	if (sourcePath) {
		suffix += ` Full project content: ${sourcePath}.`;
	}
	suffix += "]";
	return `${truncation.content}${suffix}`;
}

function projectForAgent(project: ProjectRecord, relatedTodos: RelatedTodo[]): Record<string, unknown> {
	return {
		...project,
		id: formatProjectId(project.id),
		related_todos: relatedTodos,
	};
}

function summariesForAgent(projects: ProjectSummary[]): Record<string, unknown>[] {
	return projects.map((project) => ({ ...project, id: formatProjectId(project.id) }));
}

function hasProjectWorkEntry(ctx: ExtensionContext, projectId: string): boolean {
	return ctx.sessionManager.getBranch().some((entry) => {
		if (entry.type !== "custom" || entry.customType !== PROJECT_WORK_ENTRY) {
			return false;
		}
		const data = entry.data as { project_id?: unknown } | undefined;
		return data?.project_id === projectId;
	});
}

function setProjectStatus(ctx: ExtensionContext, project: ProjectFrontMatter): void {
	ctx.ui.setStatus("project", `${formatProjectId(project.id)} ${project.title}`);
}

function restoreProjectStatus(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== PROJECT_WORK_ENTRY) {
			continue;
		}
		const data = entry.data as { project_id?: unknown; title?: unknown } | undefined;
		if (typeof data?.project_id === "string" && typeof data.title === "string") {
			ctx.ui.setStatus("project", `${formatProjectId(data.project_id)} ${data.title}`);
			return;
		}
	}
	ctx.ui.setStatus("project", undefined);
}

async function markSessionWorked(
	pi: ExtensionAPI,
	projectsDir: string,
	rawId: string,
	ctx: ExtensionContext,
): Promise<ProjectRecord | { error: string }> {
	const validated = validateProjectId(rawId);
	if ("error" in validated) {
		return validated;
	}
	const projectPath = getProjectPath(projectsDir, validated.id);
	const result = await withProjectLock(projectsDir, validated.id, ctx, async () => {
		let project: ProjectRecord;
		try {
			project = await readProjectFile(projectPath, validated.id);
		} catch {
			return { error: `Project ${formatProjectId(validated.id)} not found.` } as const;
		}
		const workedAt = new Date().toISOString();
		upsertSessionWork(project.sessions, buildSessionWork(pi, ctx, workedAt));
		project.updated_at = workedAt;
		await writeProjectFile(projectPath, project);
		return project;
	});
	if (typeof result === "object" && "error" in result) {
		return result;
	}
	if (!hasProjectWorkEntry(ctx, validated.id)) {
		pi.appendEntry(PROJECT_WORK_ENTRY, {
			project_id: validated.id,
			title: result.title,
			worked_at: new Date().toISOString(),
		});
	}
	setProjectStatus(ctx, result);
	return result;
}

function errorResult(action: ProjectAction, error: string): { content: Array<{ type: "text"; text: string }>; details: ProjectToolDetails } {
	return {
		content: [{ type: "text", text: `Error: ${error}` }],
		details: { action, error } as ProjectToolDetails,
	};
}

function renderProjectSummary(theme: Theme, project: ProjectSummary): string {
	let text = theme.fg("accent", formatProjectId(project.id));
	let renderedTitle = theme.fg("text", project.title || "(untitled)");
	if (isProjectClosed(project.status)) {
		renderedTitle = theme.fg("dim", project.title || "(untitled)");
	}
	text += ` ${renderedTitle}`;
	if (project.tags.length > 0) {
		text += theme.fg("dim", ` [${project.tags.join(", ")}]`);
	}
	text += theme.fg("muted", ` (${project.status}, ${project.session_count} sessions)`);
	return text;
}

function renderProjectDetail(theme: Theme, project: ProjectRecord, expanded: boolean): string {
	const summary = renderProjectSummary(theme, toProjectSummary(project));
	if (!expanded) {
		return summary;
	}
	const body = project.body.trim() || "No description yet.";
	const lines = [
		summary,
		theme.fg("muted", `Updated: ${project.updated_at || "unknown"}`),
		theme.fg("muted", `Sessions: ${project.sessions.length}`),
		"",
		...body.split("\n").map((line) => theme.fg("text", line)),
	];
	return lines.join("\n");
}

export default function projectsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreProjectStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreProjectStatus(ctx);
	});

	const projectsDirLabel = getProjectsDirLabel(process.cwd());
	pi.registerTool({
		name: "project",
		label: "Project",
		description:
			`Manage persistent projects in ${projectsDirLabel}. Projects are broader than todos and survive across sessions. ` +
			"Actions: list, list-all, get, create, update, append, delete, mark-worked, sessions. " +
			"Use mark-worked when the current session has contributed to a project. It records the session id, file, name, cwd, and timestamps. " +
			"Project ids are shown as PROJECT-<hex>. Tags can be replaced with tags or changed incrementally with add_tags and remove_tags. " +
			"Todos can be connected by passing project_id to the todo tool.",
		promptSnippet: "Manage persistent projects and record which sessions worked on them",
		promptGuidelines: [
			"Use project for broad, ongoing work that spans multiple todos or sessions.",
			"Use project with action mark-worked when the current session contributes to an existing project.",
			"Use todo with project_id to connect a detailed task to a project; todos may also remain unconnected.",
		],
		parameters: ProjectParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as ProjectAction;
			const projectsDir = getProjectsDir(ctx.cwd);
			const todosDir = getTodosDir(ctx.cwd);
			try {
				switch (action) {
					case "list":
					case "list-all": {
						const allProjects = await listProjects(projectsDir);
						let projects = allProjects;
						if (action === "list") {
							projects = allProjects.filter((project) => !isProjectClosed(project.status));
						}
						return {
							content: [{ type: "text", text: formatToolOutput(JSON.stringify(summariesForAgent(projects), null, 2)) }],
							details: { action, projects } as ProjectToolDetails,
						};
					}

					case "get": {
						if (!params.id) {
							return errorResult(action, "id required");
						}
						const project = await readProjectById(projectsDir, params.id);
						if ("error" in project) {
							return errorResult(action, project.error);
						}
						const relatedTodos = await listRelatedTodos(todosDir, project.id);
						const text = JSON.stringify(projectForAgent(project, relatedTodos), null, 2);
						return {
							content: [{ type: "text", text: formatToolOutput(text, getProjectPath(projectsDir, project.id)) }],
							details: { action, project, relatedTodos } as ProjectToolDetails,
						};
					}

					case "create": {
						if (!params.title) {
							return errorResult(action, "title required");
						}
						const title = normalizeTitle(params.title);
						if ("error" in title) {
							return errorResult(action, title.error);
						}
						const tags = normalizeTags(params.tags ?? []);
						if ("error" in tags) {
							return errorResult(action, tags.error);
						}
						await ensureProjectsDir(projectsDir);
						const id = await generateProjectId(projectsDir);
						const timestamp = new Date().toISOString();
						const project: ProjectRecord = {
							id,
							title: title.title,
							tags: tags.tags,
							status: params.status ?? "active",
							created_at: timestamp,
							updated_at: timestamp,
							sessions: [],
							body: params.body ?? "",
						};
						const result = await withProjectLock(projectsDir, id, ctx, async () => {
							await writeProjectFile(getProjectPath(projectsDir, id), project);
							return project;
						});
						if (typeof result === "object" && "error" in result) {
							return errorResult(action, result.error);
						}
						return {
							content: [{ type: "text", text: formatToolOutput(JSON.stringify(projectForAgent(project, []), null, 2)) }],
							details: { action, project, relatedTodos: [] } as ProjectToolDetails,
						};
					}

					case "update":
					case "append": {
						if (!params.id) {
							return errorResult(action, "id required");
						}
						const validated = validateProjectId(params.id);
						if ("error" in validated) {
							return errorResult(action, validated.error);
						}
						const result = await withProjectLock(projectsDir, validated.id, ctx, async () => {
							let project: ProjectRecord;
							try {
								project = await readProjectFile(getProjectPath(projectsDir, validated.id), validated.id);
							} catch {
								return { error: `Project ${formatProjectId(validated.id)} not found.` } as const;
							}
							if (params.title !== undefined) {
								const title = normalizeTitle(params.title);
								if ("error" in title) {
									return title;
								}
								project.title = title.title;
							}
							if (params.status !== undefined) {
								project.status = params.status;
							}
							if (params.tags !== undefined) {
								const tags = normalizeTags(params.tags);
								if ("error" in tags) {
									return tags;
								}
								project.tags = tags.tags;
							}
							if (params.add_tags !== undefined) {
								const tags = normalizeTags([...project.tags, ...params.add_tags]);
								if ("error" in tags) {
									return tags;
								}
								project.tags = tags.tags;
							}
							if (params.remove_tags !== undefined) {
								const removals = new Set(params.remove_tags.map((tag) => tag.trim().toLowerCase()));
								project.tags = project.tags.filter((tag) => !removals.has(tag.toLowerCase()));
							}
							if (params.body !== undefined) {
								if (action === "append") {
									let spacer = "";
									if (project.body.trim()) {
										spacer = "\n\n";
									}
									project.body = `${project.body.replace(/\s+$/, "")}${spacer}${params.body.trim()}\n`;
								} else {
									project.body = params.body;
								}
							}
							if (project.body.length > MAX_BODY_LENGTH) {
								return { error: `Project body cannot exceed ${MAX_BODY_LENGTH} characters.` } as const;
							}
							project.updated_at = new Date().toISOString();
							await writeProjectFile(getProjectPath(projectsDir, validated.id), project);
							return project;
						});
						if (typeof result === "object" && "error" in result) {
							return errorResult(action, result.error);
						}
						const relatedTodos = await listRelatedTodos(todosDir, result.id);
						const text = JSON.stringify(projectForAgent(result, relatedTodos), null, 2);
						return {
							content: [{ type: "text", text: formatToolOutput(text, getProjectPath(projectsDir, result.id)) }],
							details: { action, project: result, relatedTodos } as ProjectToolDetails,
						};
					}

					case "mark-worked": {
						if (!params.id) {
							return errorResult(action, "id required");
						}
						const project = await markSessionWorked(pi, projectsDir, params.id, ctx);
						if ("error" in project) {
							return errorResult(action, project.error);
						}
						const relatedTodos = await listRelatedTodos(todosDir, project.id);
						return {
							content: [{ type: "text", text: formatToolOutput(JSON.stringify(projectForAgent(project, relatedTodos), null, 2)) }],
							details: { action, project, relatedTodos } as ProjectToolDetails,
						};
					}

					case "sessions": {
						if (!params.id) {
							return errorResult(action, "id required");
						}
						const project = await readProjectById(projectsDir, params.id);
						if ("error" in project) {
							return errorResult(action, project.error);
						}
						const payload = {
							project_id: formatProjectId(project.id),
							title: project.title,
							sessions: project.sessions,
						};
						return {
							content: [{ type: "text", text: formatToolOutput(JSON.stringify(payload, null, 2), getProjectPath(projectsDir, project.id)) }],
							details: { action, project } as ProjectToolDetails,
						};
					}

					case "delete": {
						if (!params.id) {
							return errorResult(action, "id required");
						}
						const validated = validateProjectId(params.id);
						if ("error" in validated) {
							return errorResult(action, validated.error);
						}
						const relatedTodos = await listRelatedTodos(todosDir, validated.id);
						if (relatedTodos.length > 0) {
							return errorResult(action, `Project still has ${relatedTodos.length} connected todo(s). Unlink them first.`);
						}
						const result = await withProjectLock(projectsDir, validated.id, ctx, async () => {
							let project: ProjectRecord;
							try {
								project = await readProjectFile(getProjectPath(projectsDir, validated.id), validated.id);
							} catch {
								return { error: `Project ${formatProjectId(validated.id)} not found.` } as const;
							}
							await fs.unlink(getProjectPath(projectsDir, validated.id));
							return project;
						});
						if (typeof result === "object" && "error" in result) {
							return errorResult(action, result.error);
						}
						return {
							content: [{ type: "text", text: JSON.stringify(projectForAgent(result, []), null, 2) }],
							details: { action, project: result, relatedTodos: [] } as ProjectToolDetails,
						};
					}
				}
			} catch (error) {
				// ASVS 16.5.1: unexpected failures return a generic message without internal paths or stack traces.
				console.error("Project extension operation failed", error);
				return errorResult(action, "Project operation failed unexpectedly.");
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("project "));
			text += theme.fg("muted", String(args.action ?? ""));
			if (typeof args.id === "string") {
				text += ` ${theme.fg("accent", formatProjectId(args.id))}`;
			}
			if (typeof args.title === "string") {
				text += ` ${theme.fg("dim", `\"${args.title}\"`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Processing..."), 0, 0);
			}
			const details = result.details as ProjectToolDetails | undefined;
			if (!details) {
				const content = result.content[0];
				let text = "";
				if (content?.type === "text") {
					text = content.text;
				}
				return new Text(text, 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			if (details.action === "list" || details.action === "list-all") {
				if (details.projects.length === 0) {
					return new Text(theme.fg("dim", "No projects"), 0, 0);
				}
				let visibleProjects = details.projects.slice(0, 5);
				if (expanded) {
					visibleProjects = details.projects;
				}
				const lines = visibleProjects.map((project) => renderProjectSummary(theme, project));
				if (!expanded && details.projects.length > visibleProjects.length) {
					lines.push(theme.fg("dim", `... ${details.projects.length - visibleProjects.length} more`));
				}
				return new Text(lines.join("\n"), 0, 0);
			}
			if (details.action === "sessions" && details.project) {
				const lines = [renderProjectSummary(theme, toProjectSummary(details.project))];
				for (const session of details.project.sessions) {
					let label = session.session_name || session.session_id;
					label += ` (${session.last_worked_at})`;
					lines.push(`  ${theme.fg("accent", session.session_id)} ${theme.fg("muted", label)}`);
				}
				return new Text(lines.join("\n"), 0, 0);
			}
			if (
				(details.action === "get" ||
					details.action === "create" ||
					details.action === "update" ||
					details.action === "append" ||
					details.action === "delete" ||
					details.action === "mark-worked") &&
				details.project
			) {
				let text = renderProjectDetail(theme, details.project, expanded);
				if (details.action !== "get") {
					text = `${theme.fg("success", "✓ ")}${text}`;
				}
				return new Text(text, 0, 0);
			}
			return new Text(theme.fg("dim", "Project operation completed"), 0, 0);
		},
	});

	const projectCompletions = (argumentPrefix: string) => {
		const projects = listProjectsSync(getProjectsDir(process.cwd())).filter((project) => !isProjectClosed(project.status));
		const query = argumentPrefix.trim().toLowerCase();
		const matches = projects.filter((project) => {
			const text = `${formatProjectId(project.id)} ${project.title} ${project.tags.join(" ")}`.toLowerCase();
			return text.includes(query);
		});
		if (matches.length === 0) {
			return null;
		}
		return matches.map((project) => ({
			value: formatProjectId(project.id),
			label: `${formatProjectId(project.id)} ${project.title}`,
			description: `${project.status} • ${project.session_count} sessions`,
		}));
	};

	const handleProjectCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const projectsDir = getProjectsDir(ctx.cwd);
		let rawId = args.trim();
		if (!rawId) {
			const projects = (await listProjects(projectsDir)).filter((project) => !isProjectClosed(project.status));
			if (projects.length === 0) {
				ctx.ui.notify("No active projects", "warning");
				return;
			}
			if (!ctx.hasUI) {
				console.log(JSON.stringify(summariesForAgent(projects), null, 2));
				return;
			}
			const options = projects.map((project) => `${formatProjectId(project.id)} ${project.title}`);
			const selected = await ctx.ui.select("Mark this session as working on:", options);
			if (!selected) {
				return;
			}
			rawId = selected.split(/\s+/, 1)[0] ?? "";
		}
		const project = await markSessionWorked(pi, projectsDir, rawId, ctx);
		if ("error" in project) {
			ctx.ui.notify(project.error, "error");
			return;
		}
		ctx.ui.notify(`Session linked to ${formatProjectId(project.id)} ${project.title}`, "info");
	};

	pi.registerCommand("project", {
		description: "Mark the current session as having worked on a project",
		getArgumentCompletions: projectCompletions,
		handler: handleProjectCommand,
	});
	pi.registerCommand("projects", {
		description: "List projects and mark the current session as having worked on one",
		getArgumentCompletions: projectCompletions,
		handler: handleProjectCommand,
	});
}

export const projectTestApi = {
	parseProjectContent,
	serializeProject,
	upsertSessionWork,
	validateProjectId,
};
