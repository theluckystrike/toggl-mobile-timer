// Timer service: the state, the cache and the actions. It has no Obsidian import: the plugin gives it a client,
// a clock and a few callbacks, so vitest runs it against a fake Toggl.
import { RETRYABLE, type Reply, type TogglClient } from './client';
import {
	APP_NAME,
	createBody,
	dayBounds,
	entrySeconds,
	groupSeconds,
	isRunning,
	isStale,
	isoSeconds,
	newBudget,
	planReplay,
	rangeFor,
	remainingNow,
	enqueue,
	totalSeconds,
	type Budget,
	type GroupBy,
	type GroupRow,
	type PlanStep,
	type Project,
	type QueueOp,
	type ServerTimer,
	type TimeEntry,
} from './logic';

const DAY_MS = 86_400_000;
const MAX_ENTRIES = 300;
const REPORT_TTL_MS = 15 * 60_000;
/** Projects and tags change rarely: one request each per 6 hours. */
const LIST_TTL_MS = 6 * 3_600_000;

export interface TimerState {
	workspaceId: number | null;
	projects: Project[];
	projectsAt: number | null;
	tags: string[];
	tagsAt: number | null;
	entries: TimeEntry[];
	entriesAt: number | null;
	queue: QueueOp[];
	queueBase: ServerTimer | null;
	plan: PlanStep[];
	budget: { user: Budget; org: Budget };
	nextTempId: number;
}

export function emptyState(): TimerState {
	return { workspaceId: null, projects: [], projectsAt: null, tags: [], tagsAt: null, entries: [], entriesAt: null, queue: [], queueBase: null, plan: [], budget: { user: newBudget(), org: newBudget() }, nextTempId: -1 };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One entry from Toggl or from data.json, cut to the fields we use. Null for anything that is not an entry. */
export function cleanEntry(v: unknown): TimeEntry | null {
	if (!isObj(v) || typeof v.id !== 'number' || typeof v.start !== 'string' || !Number.isFinite(Date.parse(v.start))) return null;
	return {
		id: v.id,
		workspace_id: numOrNull(v.workspace_id) ?? numOrNull(v.wid) ?? 0,
		description: typeof v.description === 'string' ? v.description : null,
		start: v.start,
		stop: typeof v.stop === 'string' ? v.stop : null,
		duration: numOrNull(v.duration) ?? -1,
		project_id: numOrNull(v.project_id) ?? numOrNull(v.pid),
		project_name: typeof v.project_name === 'string' ? v.project_name : null,
		project_color: typeof v.project_color === 'string' ? v.project_color : null,
		tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : null,
	};
}

function cleanList<T>(raw: unknown, one: (v: unknown) => T | null, max: number): T[] {
	if (!Array.isArray(raw)) return [];
	const out: T[] = [];
	for (const v of raw.slice(0, max)) {
		const c = one(v);
		if (c !== null) out.push(c);
	}
	return out;
}

function cleanProject(v: unknown): Project | null {
	if (!isObj(v) || typeof v.id !== 'number' || typeof v.name !== 'string') return null;
	return { id: v.id, workspace_id: numOrNull(v.workspace_id) ?? numOrNull(v.wid) ?? 0, name: v.name, color: typeof v.color === 'string' ? v.color : '#888888', active: v.active !== false };
}

function cleanOp(v: unknown): QueueOp | null {
	if (!isObj(v) || typeof v.atMs !== 'number') return null;
	if (v.kind === 'stop') return { kind: 'stop', atMs: v.atMs };
	if (v.kind !== 'start') return null;
	const tags = Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [];
	return { kind: 'start', atMs: v.atMs, description: typeof v.description === 'string' ? v.description : '', projectId: numOrNull(v.projectId), tags };
}

function cleanBudget(v: unknown): Budget {
	if (!isObj(v)) return newBudget();
	const sent = Array.isArray(v.sent) ? v.sent.filter((t): t is number => typeof t === 'number').slice(-200) : [];
	return { remaining: numOrNull(v.remaining), resetsAtMs: numOrNull(v.resetsAtMs), blockedUntilMs: numOrNull(v.blockedUntilMs) ?? 0, failures: numOrNull(v.failures) ?? 0, sent };
}

/** Repairs saved state, so a hand-edited or old data.json never breaks the plugin. */
export function normalizeState(raw: unknown): TimerState {
	const s = emptyState();
	if (!isObj(raw)) return s;
	s.workspaceId = numOrNull(raw.workspaceId);
	s.projects = cleanList(raw.projects, cleanProject, 500);
	s.projectsAt = numOrNull(raw.projectsAt);
	s.tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 500) : [];
	s.tagsAt = numOrNull(raw.tagsAt);
	s.entries = cleanList(raw.entries, cleanEntry, MAX_ENTRIES);
	s.entriesAt = numOrNull(raw.entriesAt);
	s.queue = cleanList(raw.queue, cleanOp, 40);
	const b = isObj(raw.queueBase) ? raw.queueBase : null;
	s.queueBase = b && typeof b.id === 'number' && typeof b.workspaceId === 'number' && typeof b.startMs === 'number' ? { id: b.id, workspaceId: b.workspaceId, startMs: b.startMs } : null;
	s.plan = Array.isArray(raw.plan) ? (raw.plan.filter((p) => isObj(p) && (p.step === 'create' || p.step === 'stop')) as unknown as PlanStep[]).slice(0, 40) : [];
	const bud = isObj(raw.budget) ? raw.budget : {};
	s.budget = { user: cleanBudget(bud.user), org: cleanBudget(bud.org) };
	s.nextTempId = Math.min(-1, numOrNull(raw.nextTempId) ?? -1);
	return s;
}

export interface ServiceDeps {
	client: TogglClient;
	now: () => number;
	/** Minutes east of UTC. */
	tzOffsetMin: () => number;
	isPro: () => boolean;
	hasToken: () => boolean;
	notify: (message: string) => void;
	save: () => void;
	ttlMs: () => number;
	weekStart: () => number;
}

export interface StartRequest {
	description: string;
	projectId: number | null;
	tags: string[];
}

export type Status = 'nolink' | 'offline' | 'limited' | 'running' | 'idle';

export interface Report {
	label: string;
	by: GroupBy;
	rows: GroupRow[];
	totalSeconds: number;
	updatedAt: number;
	stale: boolean;
}

export class TimerService {
	state: TimerState;
	deps: ServiceDeps;
	private listeners = new Set<() => void>();
	private offline = false;
	private flushing = false;
	private reports = new Map<string, { entries: TimeEntry[]; at: number }>();
	/** Requests that are on their way, by range. A second report block for the same range waits for the first answer. */
	private inflight = new Map<string, Promise<Reply<TimeEntry[]>>>();
	private refreshing: Promise<boolean> | null = null;

	constructor(deps: ServiceDeps, state: TimerState) {
		this.deps = deps;
		this.state = state;
		deps.client.budgets = state.budget;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private changed(): void {
		this.deps.save();
		for (const cb of [...this.listeners]) cb();
	}

	// ------------------------------------------------------------ reading

	current(): TimeEntry | null {
		return this.state.entries.find((e) => isRunning(e)) ?? null;
	}

	/** Entries for the note log. A queued stop of a server timer is not yet a finished Toggl entry. */
	noteLogEntries(): TimeEntry[] {
		const pendingIds = new Set(this.state.plan.filter((step) => step.step === 'stop').map((step) => step.entryId));
		if (this.state.queueBase) pendingIds.add(this.state.queueBase.id);
		return this.state.entries.filter((e) => e.id > 0 && !pendingIds.has(e.id));
	}

	todaySeconds(): number {
		const now = this.deps.now();
		const day = dayBounds(now, this.deps.tzOffsetMin());
		return totalSeconds(this.state.entries, now, day.fromMs, day.toMs);
	}

	/** Entries that overlap today, newest first. */
	todayEntries(): TimeEntry[] {
		const now = this.deps.now();
		const day = dayBounds(now, this.deps.tzOffsetMin());
		const hit = this.state.entries.filter((e) => {
			const start = Date.parse(e.start);
			return start < day.toMs && start + entrySeconds(e, now) * 1000 > day.fromMs;
		});
		return hit.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
	}

	status(): Status {
		if (!this.deps.hasToken()) return 'nolink';
		// No connection comes first: its short retry wait is not a Toggl limit.
		if (this.offline) return 'offline';
		const now = this.deps.now();
		const b = this.deps.client.budgets;
		if (now < Math.max(b.user.blockedUntilMs, b.org.blockedUntilMs) || remainingNow(b.org, now) <= 0) return 'limited';
		return this.current() ? 'running' : 'idle';
	}

	/** Requests left this hour in the tighter of the two Toggl buckets, for the settings page and the panel. */
	requestsLeft(): number {
		const now = this.deps.now();
		const b = this.deps.client.budgets;
		return Math.max(0, Math.min(remainingNow(b.user, now), remainingNow(b.org, now)));
	}

	/** Longest wait in ms until Toggl accepts requests again, or 0. */
	waitMs(): number {
		const now = this.deps.now();
		const b = this.deps.client.budgets;
		return Math.max(0, b.user.blockedUntilMs - now, b.org.blockedUntilMs - now);
	}

	// ------------------------------------------------------------ requests

	private fail(r: Extract<Reply<unknown>, { ok: false }>, quiet: boolean): void {
		this.offline = r.kind === 'offline';
		if (!quiet) this.deps.notify(r.message);
		this.changed();
	}

	private async workspace(): Promise<Reply<number>> {
		if (this.state.workspaceId !== null) return { ok: true, status: 200, data: this.state.workspaceId };
		const r = await this.deps.client.me();
		if (!r.ok) return r;
		const id = r.data.default_workspace_id;
		if (!Number.isInteger(id) || id <= 0) return { ok: false, kind: 'http', status: r.status, waitMs: 0, message: 'Toggl gave no default workspace.' };
		this.state.workspaceId = id;
		return { ok: true, status: r.status, data: id };
	}

	/** One request: entries of yesterday and today give the running timer and the day total. Skipped when the cache is fresh. */
	refresh(opts: { force?: boolean; background?: boolean } = {}): Promise<boolean> {
		// A refresh that is on its way answers a second call too: layout ready, a return to the app and a button can come together.
		if (this.refreshing) return this.refreshing;
		const run = this.refreshOnce(opts).finally(() => {
			this.refreshing = null;
		});
		this.refreshing = run;
		return run;
	}

	private async refreshOnce(opts: { force?: boolean; background?: boolean }): Promise<boolean> {
		const now = this.deps.now();
		const tz = this.deps.tzOffsetMin();
		if (!this.deps.hasToken()) return false;
		if (this.deps.isPro() && (this.state.queue.length > 0 || this.state.plan.length > 0)) {
			await this.flushQueue();
			if (this.state.queue.length > 0 || this.state.plan.length > 0) return false;
		}
		if (!opts.force && !isStale(this.state.entriesAt, now, this.deps.ttlMs(), tz)) return true;
		const day = dayBounds(now, tz);
		const r = await this.deps.client.entries(day.fromMs - DAY_MS, day.toMs, opts.background === true);
		if (!r.ok) {
			this.fail(r, opts.background === true);
			return false;
		}
		this.offline = false;
		this.state.entries = cleanList(r.data, cleanEntry, MAX_ENTRIES);
		this.state.entriesAt = now;
		// A manual refresh (not a background one) also asks for the running timer, so a timer from before yesterday shows. 1 more request.
		if (opts.force === true && opts.background !== true) await this.checkCurrent();
		this.changed();
		return true;
	}

	private async checkCurrent(): Promise<void> {
		const r = await this.deps.client.current();
		if (!r.ok) return;
		const e = cleanEntry(r.data);
		if (e && isRunning(e)) this.applyEntry(e);
	}

	async loadProjects(force = false): Promise<Project[]> {
		const now = this.deps.now();
		if (!force && this.state.projectsAt !== null && now - this.state.projectsAt < LIST_TTL_MS) return this.state.projects;
		const r = await this.deps.client.projects();
		if (!r.ok) {
			this.fail(r, true);
			return this.state.projects;
		}
		this.state.projects = cleanList(r.data, cleanProject, 500);
		this.state.projectsAt = now;
		this.changed();
		return this.state.projects;
	}

	async loadTags(force = false): Promise<string[]> {
		const now = this.deps.now();
		if (!force && this.state.tagsAt !== null && now - this.state.tagsAt < LIST_TTL_MS) return this.state.tags;
		const r = await this.deps.client.tags();
		if (!r.ok) {
			this.fail(r, true);
			return this.state.tags;
		}
		this.state.tags = (Array.isArray(r.data) ? r.data : []).map((t) => t.name).filter((n) => typeof n === 'string').slice(0, 500);
		this.state.tagsAt = now;
		this.changed();
		return this.state.tags;
	}

	// ------------------------------------------------------------ start, stop, switch

	private applyEntry(e: unknown): void {
		const entry = cleanEntry(e);
		if (!entry) return;
		const list = this.state.entries.filter((x) => x.id !== entry.id);
		if (isRunning(entry)) for (const x of list) if (isRunning(x)) this.closeLocal(x, Date.parse(entry.start));
		list.push(entry);
		this.state.entries = list.slice(-MAX_ENTRIES);
		this.offline = false;
		this.changed();
	}

	private closeLocal(e: TimeEntry, stopMs: number): void {
		e.stop = isoSeconds(stopMs);
		e.duration = Math.max(0, Math.round((stopMs - Date.parse(e.start)) / 1000));
	}

	async start(req: StartRequest): Promise<boolean> {
		if (!this.deps.hasToken()) {
			this.deps.notify('Add your Toggl API token in the plugin settings.');
			return false;
		}
		const running = this.current();
		if (running && !(await this.stop())) return false;
		const startMs = this.deps.now();
		const op: QueueOp = { kind: 'start', atMs: startMs, description: req.description, projectId: req.projectId, tags: req.tags };
		const ws = await this.workspace();
		if (!ws.ok) return this.failOrQueue(ws, op);
		const r = await this.deps.client.create(ws.data, createBody({ workspaceId: ws.data, description: req.description, projectId: req.projectId, tags: req.tags, startMs }));
		if (r.ok) {
			this.applyEntry(r.data);
			return true;
		}
		return this.failOrQueue(r, op);
	}

	async stop(): Promise<boolean> {
		const running = this.current();
		if (!running) {
			this.deps.notify('No timer is running.');
			return false;
		}
		const op: QueueOp = { kind: 'stop', atMs: this.deps.now() };
		if (running.id < 0) return this.queueOp(op);
		const r = await this.deps.client.stop(running.workspace_id || (this.state.workspaceId ?? 0), running.id);
		if (r.ok) {
			this.applyEntry(r.data);
			return true;
		}
		if (r.kind === 'http' && (r.status === 404 || r.status === 409)) void this.refresh({ force: true, background: true });
		return this.failOrQueue(r, op);
	}

	/** Stops the running timer and starts a new one. Two requests; with Pro and no connection both wait in the queue. */
	async switchTo(req: StartRequest): Promise<boolean> {
		return this.start(req);
	}

	private failOrQueue(r: Extract<Reply<unknown>, { ok: false }>, op: QueueOp): boolean {
		if (RETRYABLE.has(r.kind) && this.deps.isPro()) {
			this.offline = r.kind === 'offline';
			return this.queueOp(op);
		}
		this.fail(r, false);
		if (RETRYABLE.has(r.kind) && !this.deps.isPro()) this.deps.notify('Nothing was changed. Pro keeps a change in a queue and sends it when Toggl is reachable.');
		return false;
	}

	/** Pro: keeps the change, shows it at once, and sends it later. */
	private queueOp(op: QueueOp): boolean {
		const q = enqueue(this.state.queue, op);
		if (!q) {
			this.deps.notify('The offline queue is full (40 changes). Wait until it is sent.');
			return false;
		}
		if (this.state.queue.length === 0) {
			const run = this.current();
			this.state.queueBase = run && run.id > 0 ? { id: run.id, workspaceId: run.workspace_id, startMs: Date.parse(run.start) } : null;
		}
		this.state.queue = q;
		this.applyOptimistic(op);
		this.deps.notify('Saved. It will be sent when Toggl is reachable.');
		return true;
	}

	private applyOptimistic(op: QueueOp): void {
		const run = this.current();
		if (run) this.closeLocal(run, op.atMs);
		if (op.kind === 'start') {
			const project = this.state.projects.find((p) => p.id === op.projectId);
			const id = this.state.nextTempId--;
			this.state.entries.push({ id, workspace_id: this.state.workspaceId ?? 0, description: op.description, start: isoSeconds(op.atMs), stop: null, duration: -1, project_id: op.projectId, project_name: project?.name ?? null, project_color: project?.color ?? null, tags: op.tags });
		}
		this.changed();
	}

	// ------------------------------------------------------------ queue replay (Pro)

	/** Sends queued changes in the fewest requests. Stops at the first retryable failure and keeps the rest. */
	async flushQueue(): Promise<number> {
		if (this.flushing || !this.deps.isPro()) return 0;
		this.flushing = true;
		let sent = 0;
		try {
			for (let round = 0; round < 3; round++) {
				if (this.state.plan.length === 0 && this.state.queue.length > 0) {
					this.state.plan = planReplay(this.state.queue, this.state.queueBase);
					this.state.queue = [];
					this.state.queueBase = null;
					this.changed();
				}
				if (this.state.plan.length === 0) break;
				const done = await this.runPlan();
				sent += done;
				if (this.state.plan.length > 0) break;
			}
		} finally {
			this.flushing = false;
		}
		if (sent > 0 && this.state.plan.length === 0) {
			this.deps.notify(`Sent ${sent} queued ${sent === 1 ? 'change' : 'changes'} to Toggl.`);
			await this.refresh({ force: true, background: true });
		}
		return sent;
	}

	private async runPlan(): Promise<number> {
		let sent = 0;
		for (let i = 0; i < 40 && this.state.plan.length > 0; i++) {
			const step = this.state.plan[0];
			if (!step) break;
			const r = await this.runStep(step);
			if (!r.ok && RETRYABLE.has(r.kind)) {
				this.fail(r, true);
				break;
			}
			if (!r.ok) this.deps.notify(`A queued change was dropped: ${r.message}`);
			this.state.plan.shift();
			sent++;
			this.changed();
		}
		return sent;
	}

	private async runStep(step: PlanStep): Promise<Reply<unknown>> {
		if (step.step === 'stop') {
			const secs = Math.max(0, Math.round((step.atMs - step.startMs) / 1000));
			return this.deps.client.update(step.workspaceId, step.entryId, { start: isoSeconds(step.startMs), stop: isoSeconds(step.atMs), duration: secs });
		}
		const ws = await this.workspace();
		if (!ws.ok) return ws;
		const r = await this.deps.client.create(ws.data, createBody({ workspaceId: ws.data, description: step.description, projectId: step.projectId, tags: step.tags, startMs: step.startMs, stopMs: step.stopMs }));
		if (r.ok && step.stopMs === null) {
			const e = cleanEntry(r.data);
			if (e) this.state.queueBase = { id: e.id, workspaceId: e.workspace_id, startMs: Date.parse(e.start) };
		}
		return r;
	}

	pending(): number {
		return this.state.queue.length + this.state.plan.length;
	}

	// ------------------------------------------------------------ edit and delete (Pro)

	async editEntry(id: number, patch: { description: string; projectId: number | null; startMs: number; stopMs: number }): Promise<boolean> {
		const e = this.state.entries.find((x) => x.id === id);
		if (!e || e.id < 0) return false;
		const body = createBody({ workspaceId: e.workspace_id, description: patch.description, projectId: patch.projectId, tags: e.tags ?? [], startMs: patch.startMs, stopMs: patch.stopMs });
		if (patch.projectId === null) body.project_id = null;
		const r = await this.deps.client.update(e.workspace_id, id, body);
		if (!r.ok) {
			this.fail(r, false);
			return false;
		}
		this.applyEntry(r.data);
		return true;
	}

	async deleteEntry(id: number): Promise<boolean> {
		const e = this.state.entries.find((x) => x.id === id);
		if (!e || e.id < 0) return false;
		const r = await this.deps.client.remove(e.workspace_id, id);
		if (!r.ok) {
			this.fail(r, false);
			return false;
		}
		this.state.entries = this.state.entries.filter((x) => x.id !== id);
		this.changed();
		return true;
	}

	// ------------------------------------------------------------ report (Pro)

	/** Hours by project, day or description. "today" and "yesterday" come from the cache when they can; other ranges cost one request each 15 minutes. */
	async report(spec: { range: string; by: GroupBy }, force = false): Promise<Report | { error: string }> {
		const now = this.deps.now();
		const tz = this.deps.tzOffsetMin();
		const range = rangeFor(spec.range, now, tz, this.deps.weekStart());
		if (!range) return { error: 'Range must be today, yesterday, last7, week, month or YYYY-MM-DD..YYYY-MM-DD.' };
		const key = `${range.fromMs}:${range.toMs}`;
		const hit = this.reports.get(key);
		let entries: TimeEntry[] | null = hit && !force && now - hit.at < REPORT_TTL_MS ? hit.entries : null;
		let stale = false;
		let at = hit?.at ?? now;
		if (!entries) {
			let pending = this.inflight.get(key);
			if (!pending) {
				pending = this.deps.client.entries(range.fromMs, range.toMs, false).finally(() => this.inflight.delete(key));
				this.inflight.set(key, pending);
			}
			const r = await pending;
			if (r.ok) {
				entries = cleanList(r.data, cleanEntry, 1000);
				at = now;
				this.reports.set(key, { entries, at });
				this.offline = false;
			} else if (hit) {
				entries = hit.entries;
				stale = true;
			} else {
				this.fail(r, true);
				return { error: r.message };
			}
		}
		const rows = groupSeconds(entries, spec.by, now, range, tz);
		return { label: range.label, by: spec.by, rows, totalSeconds: rows.reduce((a, r) => a + r.seconds, 0), updatedAt: at, stale };
	}
}

export { APP_NAME };
