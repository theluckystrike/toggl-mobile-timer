import { describe, expect, it } from 'vitest';
import { TogglClient, type Http, type HttpReply, type HttpRequest } from '../src/client';
import { TimerService, emptyState, normalizeState, type ServiceDeps } from '../src/service';

const T0 = Date.parse('2026-10-10T08:00:00Z');

/** A fake Toggl: keeps entries in memory, counts requests, and can be told to fail. */
class FakeToggl {
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

function make(pro: boolean, fake: FakeToggl, clock: { now: number }, token: string | null = 'secret-token-123') {
	const messages: string[] = [];
	const client = new TogglClient({ getToken: () => token, http: fake.http, now: () => clock.now, onBudget: () => undefined });
	const deps: ServiceDeps = {
		client,
		now: () => clock.now,
		tzOffsetMin: () => 0,
		isPro: () => pro,
		hasToken: () => token !== null,
		notify: (m) => messages.push(m),
		save: () => undefined,
		ttlMs: () => 600_000,
		weekStart: () => 1,
	};
	return { svc: new TimerService(deps, emptyState()), messages, client };
}

describe('TimerService', () => {
	it('refresh uses one request and a fresh cache uses none', async () => {
		const fake = new FakeToggl();
		fake.entries = [{ id: 1, workspace_id: 5, description: 'Earlier', start: '2026-10-10T06:00:00Z', stop: '2026-10-10T07:00:00Z', duration: 3600 }];
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		expect(await svc.refresh()).toBe(true);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.path).toContain('/me/time_entries?meta=true&start_date=');
		clock.now += 5 * 60_000;
		await svc.refresh({ background: true });
		expect(fake.calls).toHaveLength(1);
		expect(svc.todaySeconds()).toBe(3600);
		clock.now += 6 * 60_000;
		await svc.refresh({ background: true });
		expect(fake.calls).toHaveLength(2);
	});

	it('a manual refresh also asks for the running timer, so a timer from before yesterday shows; a background refresh does not', async () => {
		const fake = new FakeToggl();
		fake.current = { id: 55, workspace_id: 5, description: 'Old timer', start: '2026-10-05T09:00:00Z', stop: null, duration: -1 };
		const { svc } = make(false, fake, { now: T0 });
		await svc.refresh({ force: true, background: true });
		expect(fake.calls).toHaveLength(1);
		expect(svc.current()).toBeNull();
		await svc.refresh({ force: true });
		expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/me/time_entries', '/me/time_entries', '/me/time_entries/current']);
		expect(svc.current()?.description).toBe('Old timer');
	});

	it('start needs /me once for the workspace, then one request for each start', async () => {
		const fake = new FakeToggl();
		const { svc } = make(false, fake, { now: T0 });
		expect(await svc.start({ description: 'Write docs', projectId: 11, tags: [] })).toBe(true);
		expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /me', 'POST /workspaces/5/time_entries?meta=true']);
		expect(JSON.parse(fake.calls[1]?.body ?? '{}')).toMatchObject({ description: 'Write docs', project_id: 11, duration: -1, workspace_id: 5, created_with: 'Mobile Timer for Toggl Track' });
		expect(svc.current()?.description).toBe('Write docs');
		expect(svc.status()).toBe('running');
	});

	it('stop sends PATCH stop and shows the finished entry', async () => {
		const fake = new FakeToggl();
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		await svc.start({ description: 'A', projectId: null, tags: [] });
		clock.now += 600_000;
		expect(await svc.stop()).toBe(true);
		expect(fake.calls.at(-1)?.method).toBe('PATCH');
		expect(svc.current()).toBeNull();
		expect(svc.todaySeconds()).toBe(600);
	});

	it('switch is stop plus start: 2 requests after the workspace is known', async () => {
		const fake = new FakeToggl();
		const { svc } = make(false, fake, { now: T0 });
		await svc.start({ description: 'A', projectId: null, tags: [] });
		const before = fake.calls.length;
		await svc.switchTo({ description: 'B', projectId: null, tags: [] });
		expect(fake.calls.length - before).toBe(2);
		expect(svc.current()?.description).toBe('B');
	});

	it('HTTP 402 blocks every later request until the window resets, with no new request', async () => {
		const fake = new FakeToggl();
		const clock = { now: T0 };
		const { svc, messages } = make(false, fake, clock);
		fake.mode = '402';
		expect(await svc.refresh({ force: true })).toBe(false);
		expect(fake.calls).toHaveLength(1);
		for (let i = 0; i < 5; i++) await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(1);
		expect(svc.status()).toBe('limited');
		expect(messages.at(-1)).toMatch(/Try again in 31 min/);
		clock.now += 1801 * 1000;
		fake.mode = 'ok';
		expect(await svc.refresh({ force: true })).toBe(true);
		expect(fake.calls).toHaveLength(3);
		expect(fake.calls.slice(1).map((c) => c.path.split('?')[0])).toEqual(['/me/time_entries', '/me/time_entries/current']);
	});

	it('HTTP 429 backs off for 2 minutes, then 4', async () => {
		const fake = new FakeToggl();
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		fake.mode = '429';
		await svc.refresh({ force: true });
		clock.now += 119_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(1);
		clock.now += 2_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(2);
		clock.now += 239_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(2);
	});

	it('background refresh stops at the reserve, but a tap on a button still sends', async () => {
		const fake = new FakeToggl();
		const { svc } = make(false, fake, { now: T0 });
		await svc.start({ description: 'A', projectId: null, tags: [] });
		fake.remaining = 8;
		await svc.refresh({ force: true, background: true });
		const n = fake.calls.length;
		await svc.refresh({ force: true, background: true });
		await svc.refresh({ force: true, background: true });
		expect(fake.calls.length).toBe(n);
		expect((await svc.deps.client.me()).ok).toBe(true);
		expect(fake.calls.length).toBe(n + 1);
	});

	it('no connection shows as offline, not as a Toggl limit', async () => {
		const fake = new FakeToggl();
		const { svc } = make(false, fake, { now: T0 });
		fake.mode = 'offline';
		await svc.refresh({ force: true });
		expect(svc.status()).toBe('offline');
		fake.mode = '402';
		const clock = { now: T0 + 60_000 };
		const again = make(false, fake, clock);
		await again.svc.refresh({ force: true });
		expect(again.svc.status()).toBe('limited');
	});

	it('without Pro an offline start changes nothing and says so', async () => {
		const fake = new FakeToggl();
		fake.mode = 'offline';
		const { svc, messages } = make(false, fake, { now: T0 });
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(svc.state.queue).toHaveLength(0);
		expect(svc.current()).toBeNull();
		expect(messages.join(' ')).toMatch(/Pro keeps a change in a queue/);
	});

	it('with Pro an offline start and stop wait in the queue and replay as ONE request', async () => {
		const fake = new FakeToggl();
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		fake.mode = 'offline';
		fake.calls = [];
		expect(await svc.start({ description: 'Offline work', projectId: 11, tags: ['x'] })).toBe(true);
		expect(svc.current()?.description).toBe('Offline work');
		clock.now += 15 * 60_000;
		expect(await svc.stop()).toBe(true);
		expect(svc.current()).toBeNull();
		expect(svc.state.queue.map((o) => o.kind)).toEqual(['start', 'stop']);
		expect(svc.pending()).toBe(2);
		fake.mode = 'ok';
		fake.calls = [];
		clock.now += 20 * 60_000;
		expect(await svc.flushQueue()).toBe(1);
		const posts = fake.calls.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(JSON.parse(posts[0]?.body ?? '{}')).toMatchObject({ description: 'Offline work', start: '2026-10-10T08:00:00Z', stop: '2026-10-10T08:15:00Z', duration: 900, project_id: 11, tags: ['x'] });
		expect(svc.pending()).toBe(0);
	});

	it('with Pro an offline stop of a timer that runs on Toggl replays as one PUT with start, stop and duration', async () => {
		const fake = new FakeToggl();
		fake.entries = [{ id: 7, workspace_id: 5, description: 'Running', start: '2026-10-10T07:00:00Z', stop: null, duration: -1 }];
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		fake.mode = 'offline';
		expect(await svc.stop()).toBe(true);
		fake.mode = 'ok';
		fake.calls = [];
		clock.now += 60 * 60_000;
		await svc.flushQueue();
		const put = fake.calls.find((c) => c.method === 'PUT');
		expect(put?.path).toBe('/workspaces/5/time_entries/7?meta=true');
		expect(JSON.parse(put?.body ?? '{}')).toEqual({ start: '2026-10-10T07:00:00Z', stop: '2026-10-10T08:00:00Z', duration: 3600 });
	});

	it('the note log skips a queued stop of a server timer before and during replay', async () => {
		const fake = new FakeToggl();
		fake.entries = [
			{ id: 7, workspace_id: 5, description: 'Running', start: '2026-10-10T07:00:00Z', stop: null, duration: -1 },
			{ id: 9, workspace_id: 5, description: 'Finished', start: '2026-10-10T05:00:00Z', stop: '2026-10-10T06:00:00Z', duration: 3600 },
		];
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		fake.mode = 'offline';
		expect(await svc.stop()).toBe(true);
		expect(svc.state.entries.find((e) => e.id === 7)?.stop).not.toBeNull();
		expect(svc.noteLogEntries().map((e) => e.id)).toEqual([9]);
		clock.now += 60_000;
		await svc.flushQueue();
		expect(svc.state.queueBase).toBeNull();
		expect(svc.state.plan[0]).toMatchObject({ step: 'stop', entryId: 7 });
		expect(svc.noteLogEntries().map((e) => e.id)).toEqual([9]);
	});

	it('with Pro a refresh that sends the queue finishes and a later refresh still asks Toggl', async () => {
		const fake = new FakeToggl();
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		fake.mode = 'offline';
		expect(await svc.start({ description: 'Offline work', projectId: null, tags: [] })).toBe(true);
		fake.mode = 'ok';
		clock.now += 60_000;
		const late = new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500));
		expect(await Promise.race([svc.refresh({ force: true, background: true }).then(() => 'done'), late])).toBe('done');
		expect(svc.pending()).toBe(0);
		fake.calls = [];
		clock.now += 60_000;
		expect(await Promise.race([svc.refresh({ force: true }).then(() => 'done'), late])).toBe('done');
		expect(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/me/time_entries?'))).toBe(true);
	});

	it('with Pro a 402 queues the change instead of losing it', async () => {
		const fake = new FakeToggl();
		const { svc } = make(true, fake, { now: T0 });
		await svc.refresh();
		fake.mode = '402';
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(true);
		expect(svc.state.queue).toHaveLength(1);
	});

	it('the queue holds at most 40 changes', async () => {
		const fake = new FakeToggl();
		fake.mode = 'offline';
		const clock = { now: T0 };
		const { svc, messages } = make(true, fake, clock);
		for (let i = 0; i < 25; i++) {
			clock.now += 1000;
			await svc.start({ description: `t${i}`, projectId: null, tags: [] });
			clock.now += 1000;
			await svc.stop();
		}
		expect(svc.state.queue).toHaveLength(40);
		expect(messages.some((m) => /queue is full/.test(m))).toBe(true);
	});

	it('without a token no request is sent', async () => {
		const fake = new FakeToggl();
		const { svc, messages } = make(false, fake, { now: T0 }, null);
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(await svc.refresh({ force: true })).toBe(false);
		expect(fake.calls).toHaveLength(0);
		expect(svc.status()).toBe('nolink');
		expect(messages[0]).toMatch(/API token/);
	});

	it('the token is sent as Basic auth and appears nowhere in the saved state or in messages', async () => {
		const fake = new FakeToggl();
		const { svc, messages } = make(false, fake, { now: T0 }, 'secret-token-123');
		await svc.start({ description: 'A', projectId: null, tags: [] });
		fake.mode = '402';
		await svc.refresh({ force: true });
		expect(fake.calls[0]?.headers.Authorization).toBe(`Basic ${btoa('secret-token-123:api_token')}`);
		expect(JSON.stringify(svc.state)).not.toContain('secret-token-123');
		expect(messages.join(' ')).not.toContain('secret-token-123');
	});

	it('the report asks once for a range and uses the copy for 15 minutes', async () => {
		const fake = new FakeToggl();
		fake.entries = [
			{ id: 1, workspace_id: 5, description: 'a', start: '2026-10-08T06:00:00Z', stop: '2026-10-08T07:00:00Z', duration: 3600, project_id: 1, project_name: 'Docs', project_color: '#111111' },
			{ id: 2, workspace_id: 5, description: 'b', start: '2026-10-09T06:00:00Z', stop: '2026-10-09T06:30:00Z', duration: 1800, project_id: 2, project_name: 'Code', project_color: '#222222' },
		];
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		const r = await svc.report({ range: 'week', by: 'project' });
		expect(r).toMatchObject({ totalSeconds: 5400, label: 'week of 2026-10-05' });
		expect('rows' in r && r.rows.map((x) => x.key)).toEqual(['Docs', 'Code']);
		await svc.report({ range: 'week', by: 'day' });
		expect(fake.calls).toHaveLength(1);
		clock.now += 16 * 60_000;
		await svc.report({ range: 'week', by: 'day' });
		expect(fake.calls).toHaveLength(2);
		expect(await svc.report({ range: 'sometime', by: 'day' })).toHaveProperty('error');
	});

	it('two report blocks for one range at the same time cost one request, and three manual refreshes at once cost one refresh (2 requests)', async () => {
		const fake = new FakeToggl();
		const { svc } = make(true, fake, { now: T0 });
		const [a, b] = await Promise.all([svc.report({ range: 'week', by: 'project' }), svc.report({ range: 'week', by: 'day' })]);
		expect('rows' in a && 'rows' in b).toBe(true);
		expect(fake.calls).toHaveLength(1);
		fake.calls = [];
		await Promise.all([svc.refresh({ force: true }), svc.refresh({ force: true }), svc.refresh({ force: true })]);
		expect(fake.calls).toHaveLength(2);
	});

	it('edit and delete send PUT and DELETE for the entry workspace', async () => {
		const fake = new FakeToggl();
		fake.entries = [{ id: 9, workspace_id: 5, description: 'Old', start: '2026-10-10T06:00:00Z', stop: '2026-10-10T07:00:00Z', duration: 3600 }];
		const { svc } = make(true, fake, { now: T0 });
		await svc.refresh();
		expect(await svc.editEntry(9, { description: 'New', projectId: null, startMs: Date.parse('2026-10-10T06:00:00Z'), stopMs: Date.parse('2026-10-10T06:30:00Z') })).toBe(true);
		expect(svc.todaySeconds()).toBe(1800);
		expect(await svc.deleteEntry(9)).toBe(true);
		expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/workspaces/5/time_entries/9' });
		expect(svc.state.entries).toHaveLength(0);
	});
});

describe('normalizeState', () => {
	it('repairs junk', () => {
		const s = normalizeState({ workspaceId: 'x', entries: [1, { id: 'a' }, { id: 3, start: 'bad' }], queue: [{ kind: 'zap' }, { kind: 'stop', atMs: 5 }], budget: 7, nextTempId: 3, projects: [{ id: 1 }] });
		expect(s.workspaceId).toBeNull();
		expect(s.entries).toEqual([]);
		expect(s.queue).toEqual([{ kind: 'stop', atMs: 5 }]);
		expect(s.projects).toEqual([]);
		expect(s.nextTempId).toBe(-1);
		expect(s.budget.user.sent).toEqual([]);
	});
	it('round trips a saved state', () => {
		const s = emptyState();
		s.workspaceId = 5;
		s.queue = [{ kind: 'start', atMs: 1, description: 'x', projectId: 2, tags: ['t'] }];
		expect(normalizeState(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});
});

describe('ids in the URL path', () => {
	it('an entry without a workspace or id sends no request and does not throw', async () => {
		const fake = new FakeToggl();
		const { client } = make(false, fake, { now: T0 });
		for (const r of [await client.stop(0, 5), await client.stop(5, -1), await client.update(5, 1.5, {}), await client.remove(NaN, 1), await client.create(0, {})]) {
			expect(r).toMatchObject({ ok: false, kind: 'http' });
		}
		expect(fake.calls).toHaveLength(0);
	});
});
