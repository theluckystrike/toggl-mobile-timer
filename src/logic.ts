// Pure logic of Mobile Timer for Toggl Track: time math, request budget, offline queue, report ranges.
// No Obsidian import and no network here, so every function runs in vitest with golden vectors.
// Toggl API facts come from the pages saved in research/obsidian-run/raw/u8b (see BRIEF.md).

export interface TimeEntry {
	id: number;
	workspace_id: number;
	description: string | null;
	start: string;
	stop: string | null;
	duration: number;
	project_id: number | null;
	project_name?: string | null;
	project_color?: string | null;
	tags?: string[] | null;
}

export interface Project {
	id: number;
	workspace_id: number;
	name: string;
	color: string;
	active: boolean;
}

export const APP_NAME = 'Mobile Timer for Toggl Track';
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- formatting

/** Authorization header value. Toggl Basic auth with an API token: token as user name, "api_token" as password. */
export function basicAuthHeader(token: string): string {
	return `Basic ${btoa(`${token}:api_token`)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 3725 gives "1:02:05". Negative and not-finite input gives "0:00:00". */
export function formatClock(seconds: number): string {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 7500 gives "2h 05m", 2700 gives "45m", 0 gives "0m". Seconds are cut, not rounded. */
export function formatHours(seconds: number): string {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** Decimal hours with 2 places, for reports: 5400 gives "1.50". */
export function decimalHours(seconds: number): string {
	return (Math.max(0, seconds) / 3600).toFixed(2);
}

// ---------------------------------------------------------------- time math

/** True when the entry has no stop time and a negative duration (Toggl marks a running entry with -1). */
export function isRunning(e: Pick<TimeEntry, 'stop' | 'duration'>): boolean {
	return e.stop === null && e.duration < 0;
}

/** Seconds of one entry. A running entry counts from its server start time, so the value is right after a phone sleeps. */
export function entrySeconds(e: TimeEntry, nowMs: number): number {
	const start = Date.parse(e.start);
	if (!Number.isFinite(start)) return 0;
	if (e.stop) {
		const stop = Date.parse(e.stop);
		return Number.isFinite(stop) ? Math.max(0, (stop - start) / 1000) : 0;
	}
	return isRunning(e) ? Math.max(0, (nowMs - start) / 1000) : Math.max(0, e.duration);
}

/** Seconds of one entry that fall in [fromMs, toMs). A timer across midnight counts in both days. */
export function clippedSeconds(e: TimeEntry, nowMs: number, fromMs: number, toMs: number): number {
	const start = Date.parse(e.start);
	if (!Number.isFinite(start)) return 0;
	const end = start + entrySeconds(e, nowMs) * 1000;
	return Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs)) / 1000;
}

export function totalSeconds(entries: readonly TimeEntry[], nowMs: number, fromMs: number, toMs: number): number {
	let sum = 0;
	for (const e of entries) sum += clippedSeconds(e, nowMs, fromMs, toMs);
	return Math.round(sum);
}

/** Start and end (ms, end excluded) of the local day that holds nowMs. tzOffsetMin is minutes east of UTC. */
export function dayBounds(nowMs: number, tzOffsetMin: number): { fromMs: number; toMs: number } {
	const shifted = nowMs + tzOffsetMin * MIN_MS;
	const startShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
	const fromMs = startShifted - tzOffsetMin * MIN_MS;
	return { fromMs, toMs: fromMs + DAY_MS };
}

export type RangeKind = 'today' | 'yesterday' | 'week' | 'month' | 'last7' | 'custom';
export interface DateRange {
	kind: RangeKind;
	fromMs: number;
	toMs: number;
	label: string;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight (ms) of YYYY-MM-DD, or null for a bad date. */
export function parseDay(text: string, tzOffsetMin: number): number | null {
	const m = ISO_DAY.exec(text.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const utc = Date.UTC(y, mo - 1, d);
	const back = new Date(utc);
	if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
	return utc - tzOffsetMin * MIN_MS;
}

export function dayText(ms: number, tzOffsetMin: number): string {
	const d = new Date(ms + tzOffsetMin * MIN_MS);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Range from a word (today, yesterday, week, month, last7) or "YYYY-MM-DD..YYYY-MM-DD" (last day included). weekStart 1 = Monday. */
export function rangeFor(spec: string, nowMs: number, tzOffsetMin: number, weekStart = 1): DateRange | null {
	const word = spec.trim().toLowerCase();
	const today = dayBounds(nowMs, tzOffsetMin);
	if (word === 'today') return { kind: 'today', ...today, label: dayText(today.fromMs, tzOffsetMin) };
	if (word === 'yesterday') return { kind: 'yesterday', fromMs: today.fromMs - DAY_MS, toMs: today.fromMs, label: dayText(today.fromMs - DAY_MS, tzOffsetMin) };
	if (word === 'last7') return { kind: 'last7', fromMs: today.toMs - 7 * DAY_MS, toMs: today.toMs, label: 'last 7 days' };
	if (word === 'week') {
		const dow = new Date(today.fromMs + tzOffsetMin * MIN_MS).getUTCDay();
		const back = (dow - weekStart + 7) % 7;
		const fromMs = today.fromMs - back * DAY_MS;
		return { kind: 'week', fromMs, toMs: fromMs + 7 * DAY_MS, label: `week of ${dayText(fromMs, tzOffsetMin)}` };
	}
	if (word === 'month') {
		const d = new Date(today.fromMs + tzOffsetMin * MIN_MS);
		const fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - tzOffsetMin * MIN_MS;
		const toMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - tzOffsetMin * MIN_MS;
		return { kind: 'month', fromMs, toMs, label: dayText(fromMs, tzOffsetMin).slice(0, 7) };
	}
	return customRange(word, tzOffsetMin);
}

function customRange(spec: string, tzOffsetMin: number): DateRange | null {
	const parts = spec.split('..');
	if (parts.length !== 2) return null;
	const a = parseDay(parts[0] ?? '', tzOffsetMin);
	const b = parseDay(parts[1] ?? '', tzOffsetMin);
	if (a === null || b === null || b < a || b - a > 366 * DAY_MS) return null;
	return { kind: 'custom', fromMs: a, toMs: b + DAY_MS, label: `${dayText(a, tzOffsetMin)} to ${dayText(b, tzOffsetMin)}` };
}

export type GroupBy = 'project' | 'day' | 'description';
export interface GroupRow {
	key: string;
	seconds: number;
	color: string | null;
}

/** Seconds per project, day or description inside the range. Biggest first; ties by key. Days sort by date. */
export function groupSeconds(entries: readonly TimeEntry[], by: GroupBy, nowMs: number, range: Pick<DateRange, 'fromMs' | 'toMs'>, tzOffsetMin: number): GroupRow[] {
	const map = new Map<string, GroupRow>();
	for (const e of entries) {
		const sec = clippedSeconds(e, nowMs, range.fromMs, range.toMs);
		if (sec <= 0) continue;
		const key = groupKey(e, by, tzOffsetMin);
		const row = map.get(key) ?? { key, seconds: 0, color: by === 'project' ? (e.project_color ?? null) : null };
		row.seconds += sec;
		map.set(key, row);
	}
	const rows = [...map.values()].map((r) => ({ ...r, seconds: Math.round(r.seconds) }));
	rows.sort(by === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
	return rows;
}

function groupKey(e: TimeEntry, by: GroupBy, tzOffsetMin: number): string {
	if (by === 'project') return e.project_name || 'No project';
	if (by === 'day') return dayText(Date.parse(e.start), tzOffsetMin);
	return (e.description ?? '').trim() || '(no description)';
}

// ---------------------------------------------------------------- request budget

export type BucketName = 'user' | 'org';

/** Toggl counts requests per bucket: "/me" paths against the user quota, workspace paths against the organization quota. */
export function bucketOf(path: string): BucketName {
	return path.startsWith('/me') ? 'user' : 'org';
}

export interface Budget {
	/** Header X-Toggl-Quota-Remaining of the last answer, or null. */
	remaining: number | null;
	/** When the quota window ends (ms), from X-Toggl-Quota-Resets-In, or null. */
	resetsAtMs: number | null;
	/** No request before this time (ms). 0 = free. */
	blockedUntilMs: number;
	/** Failures in a row (402, 429, 5xx, no network). 0 after a good answer. */
	failures: number;
	/** Times (ms) of requests sent in the last 60 minutes. */
	sent: number[];
}

export const FREE_LIMIT_PER_HOUR = 30;
/** Background refreshes stop when this many requests or fewer are left, so a tap on Start or Stop still works. */
export const RESERVE = 8;

export function newBudget(): Budget {
	return { remaining: null, resetsAtMs: null, blockedUntilMs: 0, failures: 0, sent: [] };
}

export interface Answer {
	status: number;
	remaining?: number | null;
	resetsInSecs?: number | null;
}

/** Wait time after a failed answer. 402 follows the reset time; 429 backs off for minutes; 5xx and no network back off short. */
export function backoffMs(status: number, failures: number, resetsInSecs: number | null | undefined, jitter01 = 0): number {
	const n = Math.min(Math.max(failures, 0), 6);
	if (status === 402) {
		if (resetsInSecs && resetsInSecs > 0) return Math.min(HOUR_MS, resetsInSecs * 1000 + 1000);
		return Math.min(HOUR_MS, 5 * MIN_MS * 2 ** n);
	}
	if (status === 429) return Math.min(20 * MIN_MS, 2 * MIN_MS * 2 ** n);
	if (status >= 500 || status === 0) return Math.min(5 * MIN_MS, 10_000 * 2 ** n) + Math.floor(jitter01 * 10_000);
	return 0;
}

/** New budget after one request. status 0 means the request never reached Toggl (offline). */
export function afterAnswer(b: Budget, a: Answer, nowMs: number, jitter01 = 0): Budget {
	const sent = [...b.sent.filter((t) => nowMs - t < HOUR_MS), nowMs].slice(-200);
	const out: Budget = { ...b, sent };
	if (a.remaining !== undefined && a.remaining !== null) out.remaining = a.remaining;
	if (a.resetsInSecs !== undefined && a.resetsInSecs !== null) out.resetsAtMs = nowMs + a.resetsInSecs * 1000;
	const ok = a.status >= 200 && a.status < 300;
	// 4xx answers other than 402 and 429 are our own mistake or a missing item: they do not block later requests.
	const blocking = a.status === 402 || a.status === 429 || a.status >= 500 || a.status === 0;
	if (ok || !blocking) {
		return { ...out, failures: ok ? 0 : b.failures };
	}
	const wait = backoffMs(a.status, b.failures, a.resetsInSecs, jitter01);
	return { ...out, failures: b.failures + 1, blockedUntilMs: Math.max(b.blockedUntilMs, nowMs + wait) };
}

/** Requests left in the current window: the header value while its window is open, else 30 minus what we sent in the last hour. */
export function remainingNow(b: Budget, nowMs: number, limit = FREE_LIMIT_PER_HOUR): number {
	if (b.remaining !== null && b.resetsAtMs !== null && nowMs < b.resetsAtMs) return b.remaining;
	return limit - b.sent.filter((t) => nowMs - t < HOUR_MS).length;
}

export interface Verdict {
	ok: boolean;
	waitMs: number;
	reason: 'ok' | 'blocked' | 'quota' | 'reserve';
}

/** May a request go now? User actions (Start, Stop) may use the last requests; background refreshes keep RESERVE in hand. */
export function canSend(b: Budget, nowMs: number, background: boolean, limit = FREE_LIMIT_PER_HOUR): Verdict {
	if (nowMs < b.blockedUntilMs) return { ok: false, waitMs: b.blockedUntilMs - nowMs, reason: 'blocked' };
	const left = remainingNow(b, nowMs, limit);
	const need = background ? RESERVE + 1 : 1;
	if (left >= need) return { ok: true, waitMs: 0, reason: 'ok' };
	const windowEnd = b.resetsAtMs !== null && nowMs < b.resetsAtMs ? b.resetsAtMs : (b.sent.find((t) => nowMs - t < HOUR_MS) ?? nowMs) + HOUR_MS;
	return { ok: false, waitMs: Math.max(0, windowEnd - nowMs), reason: background && left > 0 ? 'reserve' : 'quota' };
}

/** "in 4 min", "in 35 s", "in 1 h 5 min": a wait for a Notice. */
export function formatWait(ms: number): string {
	const s = Math.max(1, Math.ceil(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.ceil(s / 60);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------------------------------------------------------------- freshness

/** Background refresh is due when the cache is older than ttlMs or from another day. */
export function isStale(fetchedAtMs: number | null, nowMs: number, ttlMs: number, tzOffsetMin: number): boolean {
	if (fetchedAtMs === null) return true;
	if (nowMs - fetchedAtMs >= ttlMs || nowMs < fetchedAtMs) return true;
	return dayBounds(fetchedAtMs, tzOffsetMin).fromMs !== dayBounds(nowMs, tzOffsetMin).fromMs;
}

// ---------------------------------------------------------------- offline queue

export interface StartOp {
	kind: 'start';
	atMs: number;
	description: string;
	projectId: number | null;
	tags: string[];
}
export interface StopOp {
	kind: 'stop';
	atMs: number;
}
export type QueueOp = StartOp | StopOp;

export const QUEUE_MAX = 40;

export interface CreateStep {
	step: 'create';
	startMs: number;
	/** null = the timer is still running. */
	stopMs: number | null;
	description: string;
	projectId: number | null;
	tags: string[];
}
export interface StopStep {
	step: 'stop';
	entryId: number;
	workspaceId: number;
	/** Start of the entry that runs on Toggl, so the update can send a consistent start, stop and duration. */
	startMs: number;
	atMs: number;
}
export interface ServerTimer {
	id: number;
	workspaceId: number;
	startMs: number;
}
export type PlanStep = CreateStep | StopStep;

/** Adds an op. Returns null when the queue is full, so the caller can tell the user. */
export function enqueue(queue: readonly QueueOp[], op: QueueOp, max = QUEUE_MAX): QueueOp[] | null {
	if (queue.length >= max) return null;
	return [...queue, op];
}

function finish(o: StartOp, stopMs: number): CreateStep | null {
	if (stopMs <= o.atMs) return null;
	return { step: 'create', startMs: o.atMs, stopMs, description: o.description, projectId: o.projectId, tags: o.tags };
}

/**
 * Turns queued ops into the fewest requests. A start followed by a stop becomes one finished entry (1 request, not 2).
 * A start while another runs ends the first one at that moment, as Toggl does. server is the timer that ran on Toggl
 * when the queue began, or null.
 */
export function planReplay(ops: readonly QueueOp[], server: ServerTimer | null): PlanStep[] {
	const steps: PlanStep[] = [];
	let open: StartOp | null = null;
	let srv = server;
	const sorted = [...ops].sort((a, b) => a.atMs - b.atMs);
	for (const op of sorted) {
		if (open) {
			const done = finish(open, op.atMs);
			if (done) steps.push(done);
			open = null;
		} else if (srv) {
			steps.push({ step: 'stop', entryId: srv.id, workspaceId: srv.workspaceId, startMs: srv.startMs, atMs: op.atMs });
			srv = null;
		}
		if (op.kind === 'start') open = op;
	}
	if (open) steps.push({ step: 'create', startMs: open.atMs, stopMs: null, description: open.description, projectId: open.projectId, tags: open.tags });
	return steps;
}

// ---------------------------------------------------------------- request bodies

/** RFC 3339 UTC time without milliseconds, as the Toggl docs show: 2006-01-02T15:04:05Z. */
export function isoSeconds(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export interface StartInput {
	workspaceId: number;
	description: string;
	projectId: number | null;
	tags: string[];
	startMs: number;
	stopMs?: number | null;
}

/** Body for POST /workspaces/{id}/time_entries. A running timer has duration -1 and no stop; a finished one has stop and duration. */
export function createBody(i: StartInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		created_with: APP_NAME,
		description: i.description,
		start: isoSeconds(i.startMs),
		workspace_id: i.workspaceId,
		duration: -1,
	};
	if (i.projectId !== null) body.project_id = i.projectId;
	if (i.tags.length > 0) body.tags = i.tags;
	if (i.stopMs !== undefined && i.stopMs !== null) {
		body.stop = isoSeconds(i.stopMs);
		body.duration = Math.max(0, Math.round((Math.floor(i.stopMs / 1000) * 1000 - Math.floor(i.startMs / 1000) * 1000) / 1000));
	}
	return body;
}

// ---------------------------------------------------------------- projects and notes

/** Project by exact name (any case) or numeric id text. */
export function findProject(projects: readonly Project[], ref: string): Project | null {
	const text = ref.trim().toLowerCase();
	if (!text) return null;
	return projects.find((p) => p.active && (p.name.toLowerCase() === text || String(p.id) === text)) ?? null;
}

/** Project reference from note properties: "toggl-project" or "toggl_project". Not a string gives null. */
export function noteProjectRef(frontmatter: Record<string, unknown> | null | undefined): string | null {
	const raw = frontmatter?.['toggl-project'] ?? frontmatter?.['toggl_project'];
	if (typeof raw === 'number') return String(raw);
	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Splits "a, b ,,c" into clean tag names, at most 10. */
export function parseTags(text: string): string[] {
	const out: string[] = [];
	for (const t of text.split(',')) {
		const v = t.trim();
		if (v && !out.includes(v) && out.length < 10) out.push(v);
	}
	return out;
}

/** Description for a timer started from a note: the note name, cut at 120 characters. */
export function descriptionFromNote(basename: string): string {
	return basename.trim().slice(0, 120);
}

/**
 * The description that a note offers to Toggl. With the setting "Use the note title as the description" off, or with no
 * open note, it is empty, so no note title goes into a request unless the user types it.
 */
export function noteDescription(basename: string | null | undefined, useTitle: boolean): string {
	return useTitle && typeof basename === 'string' ? descriptionFromNote(basename) : '';
}

// ---------------------------------------------------------------- report block

export interface ReportSpec {
	range: string;
	by: GroupBy;
	title: string;
}

/** Reads the lines of a toggl-report code block: "range: week", "by: project", "title: text". Returns an error text for a bad line. */
export function parseReportSpec(source: string): { spec: ReportSpec } | { error: string } {
	const spec: ReportSpec = { range: 'today', by: 'project', title: '' };
	for (const raw of source.split('\n').slice(0, 20)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const i = line.indexOf(':');
		if (i < 1) return { error: `Cannot read the line "${line.slice(0, 40)}". Use "range: week".` };
		const key = line.slice(0, i).trim().toLowerCase();
		const val = line.slice(i + 1).trim();
		if (key === 'range') spec.range = val;
		else if (key === 'by') {
			if (val !== 'project' && val !== 'day' && val !== 'description') return { error: 'by must be project, day or description.' };
			spec.by = val;
		} else if (key === 'title') spec.title = val.slice(0, 80);
		else return { error: `Unknown key "${key.slice(0, 20)}". Use range, by or title.` };
	}
	return { spec };
}

/** A report as a Markdown table text with a total row. Used for the copy button and in tests. */
export function reportMarkdown(rows: readonly GroupRow[], by: GroupBy): string {
	const head = by === 'project' ? 'Project' : by === 'day' ? 'Day' : 'Description';
	const lines = [`| ${head} | Hours |`, '| --- | ---: |'];
	let total = 0;
	for (const r of rows) {
		total += r.seconds;
		lines.push(`| ${r.key.replace(/\|/g, '\\|')} | ${decimalHours(r.seconds)} |`);
	}
	lines.push(`| **Total** | **${decimalHours(total)}** |`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- note log (free)

/** The heading is plain text. An empty or bad saved value uses the default. */
export function logHeading(value: unknown): string {
	return typeof value === 'string' ? value.replace(/^\s*#{1,6}\s*/, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'Time tracking' : 'Time tracking';
}

const logText = (value: string): string => value.replace(/\s+/g, ' ').trim().replace(/[\\`*_{}[\]()<>!#|]/g, '\\$&');
const localStamp = (ms: number, tzOffsetMin: number): string => new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 16).replace('T', ' ');

export interface NoteLogEdit {
	offset: number;
	text: string;
	count: number;
	/** Set when an unclosed code block or frontmatter stops the insertion. */
	blocked?: true;
}

/** Adds today's finished entries from the cache. The marker stops a second copy in the same note and day. */
export function noteLogEdit(content: string, entries: readonly TimeEntry[], nowMs: number, tzOffsetMin: number, heading: string): NoteLogEdit {
	const day = dayBounds(nowMs, tzOffsetMin);
	const date = localStamp(day.fromMs, tzOffsetMin).slice(0, 10);
	const seen = new Set<string>();
	const rows: string[] = [];
	for (const e of [...entries].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
		if (!Number.isInteger(e.id) || e.id <= 0 || !Number.isInteger(e.workspace_id) || e.workspace_id <= 0 || !e.stop || isRunning(e)) continue;
		const start = Date.parse(e.start);
		const stop = Date.parse(e.stop);
		if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start || stop > nowMs) continue;
		const from = Math.max(start, day.fromMs);
		const to = Math.min(stop, day.toMs);
		const seconds = Math.floor((to - from) / 1000);
		if (seconds <= 0) continue;
		const marker = `<!-- toggl-entry:${e.workspace_id}:${e.id}:${date} -->`;
		if (content.includes(marker) || seen.has(marker)) continue;
		seen.add(marker);
		const description = logText(e.description || '(no description)');
		const project = logText(e.project_name || '(no project)');
		rows.push(`- ${localStamp(from, tzOffsetMin)} to ${localStamp(to, tzOffsetMin)} | ${description} | ${project} | ${formatClock(seconds)} ${marker}`);
	}
	if (!rows.length) return { offset: content.length, text: '', count: 0 };
	const title = logHeading(heading);
	const lines = content.split('\n');
	let offset = 0;
	let level = 0;
	let found = false;
	let fence: string | null = null;
	let frontmatter = false;
	for (const [index, raw] of lines.entries()) {
		const line = raw.replace(/\r$/, '');
		if (index === 0 && line === '---') frontmatter = true;
		else if (frontmatter && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
		else if (!frontmatter) {
			const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (code && !fence) fence = code[1] ?? null;
			else if (code && fence && code[1]?.[0] === fence[0] && (code[1]?.length ?? 0) >= fence.length && !code[2]?.trim()) fence = null;
			else if (!fence) {
				const h = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
				if (h) {
					const depth = h[1]?.length ?? 0;
					if (found && depth <= level) break;
					const text = (h[2]?.replace(/\s+#+\s*$/, '') ?? '').toLowerCase();
					if (!found && [title, logText(title)].some((t) => t.toLowerCase() === text)) {
						found = true;
						level = depth;
					}
				}
			}
		}
		offset += raw.length + (index < lines.length - 1 ? 1 : 0);
	}
	if (fence || frontmatter) return { offset: content.length, text: '', count: 0, blocked: true };
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const before = content.slice(0, offset);
	const gap = before.length === 0 || before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol;
	const head = found ? '' : `## ${logText(title)}${eol}${eol}`;
	return { offset, text: gap + head + rows.join(eol) + eol + eol, count: rows.length };
}

// ---------------------------------------------------------------- golden vectors

/** One entry point for packages/spec/vectors/toggl-mobile-timer.json: fn names a function above, args are its arguments. */
export function evalVector(fn: string, args: unknown[]): unknown {
	const table: Record<string, (...a: never[]) => unknown> = {
		formatClock,
		formatHours,
		decimalHours,
		entrySeconds,
		clippedSeconds,
		totalSeconds,
		dayBounds,
		rangeFor,
		groupSeconds,
		bucketOf,
		backoffMs,
		afterAnswer,
		canSend,
		remainingNow,
		formatWait,
		isStale,
		planReplay,
		createBody,
		isoSeconds,
		findProject,
		noteProjectRef,
		parseTags,
		parseReportSpec,
		reportMarkdown,
		logHeading,
		noteLogEdit,
		basicAuthHeader,
		enqueue,
	};
	const f = table[fn];
	if (!f) throw new Error(`unknown vector function ${fn}`);
	return (f as (...a: unknown[]) => unknown)(...args);
}
