import type { Http, HttpReply, HttpRequest } from '../src/client';

/** A fake Toggl: keeps entries in memory, counts requests, and can be told to fail. */
export class FakeToggl {
	calls: HttpRequest[] = [];
	entries: Record<string, unknown>[] = [];
	/** Answer of GET /me/time_entries/current: a timer from before the date range, or null. */
	current: Record<string, unknown> | null = null;
	nextId = 100;
	mode: 'ok' | 'offline' | '402' | '429' = 'ok';
	remaining = 30;

	http: Http = (r) => {
		this.calls.push(r);
		const headers = { 'X-Toggl-Quota-Remaining': String(this.remaining), 'X-Toggl-Quota-Resets-In': '1800' };
		if (this.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
		if (this.mode === '402') return Promise.resolve({ status: 402, json: 'quota', headers: { ...headers, 'X-Toggl-Quota-Remaining': '0' } });
		if (this.mode === '429') return Promise.resolve({ status: 429, json: null, headers: {} });
		this.remaining = Math.max(0, this.remaining - 1);
		return Promise.resolve(this.answer(r, headers));
	};

	private answer(r: HttpRequest, headers: Record<string, string>): HttpReply {
		const body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
		if (r.method === 'GET' && r.path === '/me') return { status: 200, json: { id: 1, fullname: 'Demo User', default_workspace_id: 5 }, headers };
		if (r.method === 'GET' && r.path.startsWith('/me/time_entries/current')) return { status: 200, json: this.current, headers };
		if (r.method === 'GET' && r.path.startsWith('/me/time_entries')) return { status: 200, json: this.entries, headers };
		if (r.method === 'POST') {
			const e = { id: this.nextId++, workspace_id: 5, ...body, stop: body.stop ?? null };
			this.entries.push(e);
			return { status: 200, json: e, headers };
		}
		if (r.method === 'PATCH' && r.path.endsWith('/stop?meta=true')) {
			const id = Number(/time_entries\/(\d+)\/stop/.exec(r.path)?.[1]);
			const e = this.entries.find((x) => x.id === id);
			if (e) Object.assign(e, { stop: '2026-10-10T08:10:00Z', duration: 600 });
			return { status: 200, json: e ?? null, headers };
		}
		if (r.method === 'PUT') {
			const id = Number(/time_entries\/(\d+)/.exec(r.path)?.[1]);
			const e = this.entries.find((x) => x.id === id);
			if (e) Object.assign(e, body);
			return { status: 200, json: e ?? null, headers };
		}
		return { status: 200, json: null, headers };
	}
}

