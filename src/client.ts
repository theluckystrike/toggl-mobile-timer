// Toggl Track API v9 client over Obsidian requestUrl (no Node, works on phone and tablet).
// Every request goes through the request budget in logic.ts: 30 requests an hour on the Toggl free plan, 402 and 429 back off.
// The API token is read from SecretStorage for each request. It is never stored here, logged or put in an error text.
import { requestUrl } from 'obsidian';
import {
	afterAnswer,
	basicAuthHeader,
	bucketOf,
	canSend,
	formatWait,
	newBudget,
	type Budget,
	type BucketName,
	type Project,
	type TimeEntry,
} from './logic';

export interface HttpRequest {
	/** Path after /api/v9, starting with "/". */
	path: string;
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	headers: Record<string, string>;
	body?: string;
}
export interface HttpReply {
	status: number;
	json: unknown;
	headers: Record<string, string>;
}
export type Http = (r: HttpRequest) => Promise<HttpReply>;

/**
 * The one network call site of the Toggl client. The URL starts with a literal prefix that ends the host, so the path
 * cannot change the host (tools/network-gate.mjs, product.yaml network_path_hosts). status 0 means no answer: offline.
 */
export const obsidianHttp: Http = async (r) => {
	try {
		const res = await requestUrl({ url: `https://api.track.toggl.com/api/v9${r.path}`, method: r.method, headers: r.headers, body: r.body, throw: false });
		let json: unknown = null;
		try {
			json = res.json;
		} catch {
			json = null;
		}
		return { status: res.status, json, headers: res.headers };
	} catch {
		return { status: 0, json: null, headers: {} };
	}
};

export type FailKind = 'cancelled' | 'no-token' | 'blocked' | 'quota' | 'offline' | 'rate' | 'server' | 'auth' | 'http';
export type Reply<T> = { ok: true; status: number; data: T } | { ok: false; kind: FailKind; status: number; waitMs: number; message: string };

/** Failures that a queued change may retry later. Auth and other 4xx answers are not queued. */
export const RETRYABLE: ReadonlySet<FailKind> = new Set<FailKind>(['blocked', 'quota', 'offline', 'rate', 'server']);

const header = (h: Record<string, string>, name: string): string | null => {
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key === undefined ? null : (h[key] ?? null);
};
const num = (v: string | null): number | null => {
	if (v === null || v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

export interface Me {
	id: number;
	fullname: string;
	default_workspace_id: number;
}

export interface TogglOptions {
	getToken: () => string | null;
	http: Http;
	now: () => number;
	/** Called after each request, so the plugin can save the budget. */
	onBudget: () => void;
	canRequest?: () => boolean;
}

export const CANCELLED = { ok: false, kind: 'cancelled', status: 0, waitMs: 0, message: 'Timer operation cancelled. Unsent changes are kept.' } as const;

export class TogglClient {
	private disposed = false;
	private requests = new Set<Promise<unknown>>();
	budgets: Record<BucketName, Budget> = { user: newBudget(), org: newBudget() };
	opts: TogglOptions;

	constructor(opts: TogglOptions) {
		this.opts = opts;
	}

	/** requestUrl cannot abort an in-flight request. Let it settle, but never start another. */
	dispose(): void {
		this.disposed = true;
	}

	async settled(): Promise<void> {
		await Promise.allSettled([...this.requests]);
	}

	call<T>(method: HttpRequest['method'], path: string, body: unknown, background: boolean): Promise<Reply<T>> {
		const run = this.callOnce<T>(method, path, body, background);
		this.requests.add(run);
		void run.then(() => this.requests.delete(run), () => this.requests.delete(run));
		return run;
	}

	private async callOnce<T>(method: HttpRequest['method'], path: string, body: unknown, background: boolean): Promise<Reply<T>> {
		if (this.disposed) return CANCELLED;
		if (this.opts.canRequest?.() === false) return fail('blocked', 0, 0, 'Previous Toggl request pending. Changes stay queued until it settles.');
		const token = this.opts.getToken();
		if (!token) return fail('no-token', 0, 0, 'Add your Toggl API token in the plugin settings.');
		const bucket = bucketOf(path);
		const now = this.opts.now();
		const verdict = canSend(this.budgets[bucket], now, background);
		if (!verdict.ok) {
			const kind: FailKind = verdict.reason === 'blocked' ? 'blocked' : 'quota';
			return fail(kind, 0, verdict.waitMs, `Toggl asks us to wait. Try again in ${formatWait(verdict.waitMs)}.`);
		}
		const headers: Record<string, string> = { Authorization: basicAuthHeader(token), 'Content-Type': 'application/json' };
		const reply = await this.opts.http({ path, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const after = this.opts.now();
		const answer = { status: reply.status, remaining: num(header(reply.headers, 'x-toggl-quota-remaining')), resetsInSecs: num(header(reply.headers, 'x-toggl-quota-resets-in')) };
		this.budgets[bucket] = afterAnswer(this.budgets[bucket], answer, after, Math.random());
		this.opts.onBudget();
		return classify<T>(reply, Math.max(0, this.budgets[bucket].blockedUntilMs - after));
	}

	me(background = false): Promise<Reply<Me>> {
		return this.call<Me>('GET', '/me', undefined, background);
	}

	/** Entries that start in [fromMs, toMs), with project names. One request gives the running timer and the day total. */
	entries(fromMs: number, toMs: number, background: boolean): Promise<Reply<TimeEntry[]>> {
		const a = encodeURIComponent(new Date(fromMs).toISOString());
		const b = encodeURIComponent(new Date(toMs).toISOString());
		return this.call<TimeEntry[]>('GET', `/me/time_entries?meta=true&start_date=${a}&end_date=${b}`, undefined, background);
	}

	/** The timer that runs now, or null. Used by a manual refresh: a timer that started before yesterday is not in the date range. */
	current(): Promise<Reply<TimeEntry | null>> {
		return this.call<TimeEntry | null>('GET', '/me/time_entries/current?meta=true', undefined, false);
	}

	projects(background = false): Promise<Reply<Project[]>> {
		return this.call<Project[]>('GET', '/me/projects', undefined, background);
	}

	tags(background = false): Promise<Reply<{ id: number; name: string }[]>> {
		return this.call<{ id: number; name: string }[]>('GET', '/me/tags', undefined, background);
	}

	create(workspaceId: number, body: Record<string, unknown>): Promise<Reply<TimeEntry>> {
		if (!validId(workspaceId)) return Promise.resolve(BAD_ID);
		return this.call<TimeEntry>('POST', `/workspaces/${workspaceId}/time_entries?meta=true`, body, false);
	}

	stop(workspaceId: number, entryId: number): Promise<Reply<TimeEntry>> {
		if (!validId(workspaceId) || !validId(entryId)) return Promise.resolve(BAD_ID);
		return this.call<TimeEntry>('PATCH', `/workspaces/${workspaceId}/time_entries/${entryId}/stop?meta=true`, undefined, false);
	}

	update(workspaceId: number, entryId: number, body: Record<string, unknown>): Promise<Reply<TimeEntry>> {
		if (!validId(workspaceId) || !validId(entryId)) return Promise.resolve(BAD_ID);
		return this.call<TimeEntry>('PUT', `/workspaces/${workspaceId}/time_entries/${entryId}?meta=true`, body, false);
	}

	remove(workspaceId: number, entryId: number): Promise<Reply<unknown>> {
		if (!validId(workspaceId) || !validId(entryId)) return Promise.resolve(BAD_ID);
		return this.call<unknown>('DELETE', `/workspaces/${workspaceId}/time_entries/${entryId}`, undefined, false);
	}
}

/** Ids go into the URL path, so only whole positive numbers pass. No request is sent for any other value. */
export function validId(n: number): boolean {
	return Number.isInteger(n) && n > 0;
}

const BAD_ID = { ok: false, kind: 'http', status: 0, waitMs: 0, message: 'The entry has no Toggl number yet. Run "Refresh timer" and try again.' } as const;

function fail(kind: FailKind, status: number, waitMs: number, message: string): { ok: false; kind: FailKind; status: number; waitMs: number; message: string } {
	return { ok: false, kind, status, waitMs, message };
}

/** Maps a reply to a result. The message never holds the token or a header. */
function classify<T>(r: HttpReply, waitMs: number): Reply<T> {
	if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, data: r.json as T };
	if (r.status === 0) return fail('offline', 0, waitMs, 'No connection to Toggl.');
	if (r.status === 402) return fail('quota', 402, waitMs, `Toggl request limit reached. Try again in ${formatWait(waitMs)}.`);
	if (r.status === 429) return fail('rate', 429, waitMs, `Toggl says too many requests. Try again in ${formatWait(waitMs)}.`);
	if (r.status === 401 || r.status === 403) return fail('auth', r.status, 0, 'Toggl did not accept the API token. Check it in the plugin settings.');
	if (r.status >= 500) return fail('server', r.status, waitMs, 'Toggl has a problem. Try again soon.');
	const text = typeof r.json === 'string' ? r.json.slice(0, 120) : '';
	return fail('http', r.status, 0, `Toggl answered ${r.status}${text ? `: ${text}` : ''}.`);
}
