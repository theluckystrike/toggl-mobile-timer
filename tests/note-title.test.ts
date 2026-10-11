import { describe, expect, it } from 'vitest';
import { TogglClient, type Http, type HttpRequest } from '../src/client';
import { noteDescription } from '../src/logic';
import { TimerService, emptyState } from '../src/service';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

const T0 = Date.parse('2026-10-10T08:00:00Z');
const TITLE = 'Quarterly plan for Acme';

/** A minimal Toggl: answers every request and keeps the request list, so a test can read exactly what is sent. */
function wire() {
	const calls: HttpRequest[] = [];
	const http: Http = (r) => {
		calls.push(r);
		const body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
		const headers = { 'X-Toggl-Quota-Remaining': '25', 'X-Toggl-Quota-Resets-In': '1800' };
		if (r.path === '/me') return Promise.resolve({ status: 200, json: { id: 1, fullname: 'Demo', default_workspace_id: 5 }, headers });
		if (r.method === 'POST') return Promise.resolve({ status: 200, json: { id: 100, workspace_id: 5, ...body, stop: null }, headers });
		if (r.method === 'PATCH') return Promise.resolve({ status: 200, json: { id: 100, workspace_id: 5, start: '2026-10-10T08:00:00Z', stop: '2026-10-10T08:10:00Z', duration: 600, description: body.description ?? '' }, headers });
		return Promise.resolve({ status: 200, json: [], headers });
	};
	const client = new TogglClient({ getToken: () => 'secret-token-123', http, now: () => T0, onBudget: () => undefined });
	const svc = new TimerService(
		{ client, now: () => T0, tzOffsetMin: () => 0, isPro: () => false, hasToken: () => true, notify: () => undefined, save: () => undefined, ttlMs: () => 600_000, weekStart: () => 1 },
		emptyState(),
	);
	return { svc, calls };
}

describe('note title as the description', () => {
	it('is on by default and repaired from bad saved data', () => {
		expect(DEFAULT_SETTINGS.useNoteTitle).toBe(true);
		expect(normalizeSettings({}).useNoteTitle).toBe(true);
		expect(normalizeSettings({ useNoteTitle: 'no' as never }).useNoteTitle).toBe(true);
		expect(normalizeSettings({ useNoteTitle: false }).useNoteTitle).toBe(false);
	});

	it('noteDescription gives the trimmed title only when the setting is on and a note is open', () => {
		expect(noteDescription(`  ${TITLE} `, true)).toBe(TITLE);
		expect(noteDescription('x'.repeat(300), true)).toHaveLength(120);
		expect(noteDescription(TITLE, false)).toBe('');
		expect(noteDescription(undefined, true)).toBe('');
		expect(noteDescription(null, true)).toBe('');
	});

	it('with the setting on, a timer from a note sends the title as the description', async () => {
		const { svc, calls } = wire();
		await svc.start({ description: noteDescription(TITLE, true), projectId: null, tags: [] });
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body && JSON.parse(post.body)).toMatchObject({ description: TITLE });
	});

	it('with the setting off, no request holds the note title', async () => {
		const { svc, calls } = wire();
		await svc.start({ description: noteDescription(TITLE, false), projectId: null, tags: [] });
		await svc.stop();
		await svc.refresh({ force: true });
		expect(calls.length).toBeGreaterThan(2);
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body && JSON.parse(post.body)).toMatchObject({ description: '' });
		const everything = JSON.stringify(calls.map((c) => [c.path, c.body ?? '']));
		expect(everything).not.toContain('Quarterly');
		expect(everything).not.toContain('Acme');
	});
});
