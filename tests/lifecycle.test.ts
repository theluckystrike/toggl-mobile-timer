import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type TogglMobileTimerPlugin from '../src/main';
import type { Http } from '../src/client';
import { FakeToggl } from './fake-toggl';
import manifest from '../manifest.json';

vi.mock('../src/license/github-obsidian', () => ({
	createGitHubSponsors: () => ({ init: () => undefined, onChange: () => () => undefined, isPro: () => false, refresh: async () => undefined }),
	sponsorsSettingItems: () => [],
}));

const T0 = Date.parse('2026-10-10T08:00:00Z');
const first = { step: 'create', startMs: T0, stopMs: T0 + 60_000, description: 'Already sent before disable', projectId: null, tags: [] };
const later = { ...first, startMs: T0 + 60_000, stopMs: T0 + 120_000, description: 'Old later work' };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const turns = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('actual plugin lifecycle across module reload', () => {
	afterEach(() => vi.restoreAllMocks());
	it.each([false, true])('retains known create progress and newer settings/UNSENT work with running create %s', async (running) => {
		const app = App.createConfigured__({ files: {} });
		const fake = new FakeToggl();
		let disk: unknown = { settings: { refreshMinutes: 5 }, state: { workspaceId: 5, plan: [{ ...first, stopMs: running ? null : first.stopMs }, later] } };
		const writes: unknown[] = [];
		const owners: TogglMobileTimerPlugin[] = [];
		const load = async (): Promise<TogglMobileTimerPlugin> => {
			vi.resetModules();
			const { default: Plugin } = await import('../src/main');
			const p = new Plugin(app as never, manifest as never);
			vi.spyOn(p, 'loadData').mockImplementation(async () => copy(disk));
			vi.spyOn(p, 'saveData').mockImplementation(async (data: unknown) => { disk = copy(data); writes.push(disk); });
			vi.spyOn(p, 'refreshChrome').mockImplementation(() => undefined);
			vi.spyOn(p, 'registerView').mockImplementation(() => undefined);
			await p.onload();
			owners.push(p);
			return p;
		};
		const eligible = (p: TogglMobileTimerPlugin, http: Http): void => {
			p.service.deps.isPro = () => true;
			p.service.deps.hasToken = () => true;
			p.service.deps.now = () => T0 + 180_000;
			p.service.deps.client.opts.getToken = () => 'controlled-fixture';
			p.service.deps.client.opts.http = http;
		};
		const old = await load();
		await turns();
		let release!: () => void;
		eligible(old, async (r) => {
			const reply = await fake.http(r);
			return new Promise((resolve) => { release = () => resolve(reply); });
		});
		const replay = old.service.flushQueue();
		await turns();
		expect(fake.calls.map((c) => c.method)).toEqual(['POST']);
		old.onunload();
		await old.persist();
		const fresh = await load();
		eligible(fresh, fake.http);
		await fresh.service.flushQueue();
		expect(fake.entries.filter((e) => e.description === first.description)).toHaveLength(1);
		expect(fresh.pillText()).toMatch(/pending.*queued/);
		const { TogglMobileTimerSettingTab } = await import('../src/settings');
		await new TogglMobileTimerSettingTab(app as never, fresh).setControlValue('refreshMinutes', 13);
		expect(await fresh.service.start({ description: 'New instance unsent action', projectId: null, tags: [] })).toBe(true);
		await fresh.persist();
		expect(copy(disk)).toMatchObject({ settings: { refreshMinutes: 13 }, state: { queue: [{ description: 'New instance unsent action' }] } });
		fresh.onunload();
		const newest = await load();
		eligible(newest, fake.http);
		await newest.service.flushQueue();
		expect(fake.calls).toHaveLength(1);
		fake.mode = 'offline';
		release();
		expect(await replay).toBe(1);
		await turns();
		await newest.persist();
		const saved = copy(disk) as { settings: { refreshMinutes: number }; state: { queue: { description: string }[]; plan: typeof later[]; queueBase: { id: number } | null } };
		expect(saved.settings.refreshMinutes).toBe(13);
		expect(saved.state.queue.map((q) => q.description)).toContain('New instance unsent action');
		expect(saved.state.plan).toEqual([later]);
		if (running) expect(saved.state.queueBase?.id).toBe(100);
		expect(fake.entries.filter((e) => e.description === first.description)).toHaveLength(1);
		fake.mode = 'ok';
		for (const b of Object.values(newest.service.deps.client.budgets)) Object.assign(b, { blockedUntilMs: 0, remaining: null, sent: [] });
		await newest.service.flushQueue();
		expect(fake.entries.map((e) => e.description)).toEqual([first.description, later.description, 'New instance unsent action']);
		expect(newest.service.pending()).toBe(0);
		expect(writes.length).toBeGreaterThan(3);
		for (const p of owners) p.onunload();
		await newest.persist();
	});
});

it('late old success preserves newer settings and a genuinely offline action without fresh replay', async () => {
	const app = App.createConfigured__({ files: {} });
	const fake = new FakeToggl();
	let disk: unknown = { settings: { refreshMinutes: 5 }, state: { workspaceId: 5, plan: [first, later] } };
	const load = async (): Promise<TogglMobileTimerPlugin> => {
		vi.resetModules();
		const { default: Plugin } = await import('../src/main');
		const p = new Plugin(app as never, manifest as never);
		vi.spyOn(p, 'loadData').mockImplementation(async () => copy(disk));
		vi.spyOn(p, 'saveData').mockImplementation(async (data: unknown) => { disk = copy(data); });
		vi.spyOn(p, 'refreshChrome').mockImplementation(() => undefined);
		vi.spyOn(p, 'registerView').mockImplementation(() => undefined);
		await p.onload();
		await turns();
		p.service.deps.client.opts.getToken = () => 'controlled-fixture';
		p.service.deps.hasToken = () => true;
		p.service.deps.client.opts.http = fake.http;
		return p;
	};
	const old = await load();
	old.service.deps.isPro = () => true;
	let release!: () => void;
	old.service.deps.client.opts.http = async (r) => {
		const reply = await fake.http(r);
		return new Promise((resolve) => { release = () => resolve(reply); });
	};
	const replay = old.service.flushQueue();
	await turns();
	old.onunload();
	await old.persist();
	const fresh = await load();
	fresh.service.deps.isPro = () => true;
	fake.mode = 'offline';
	const { TogglMobileTimerSettingTab } = await import('../src/settings');
	await new TogglMobileTimerSettingTab(app as never, fresh).setControlValue('refreshMinutes', 13);
	expect(await fresh.service.start({ description: 'New offline action', projectId: null, tags: [] })).toBe(true);
	await fresh.persist();
	release();
	expect(await replay).toBe(1);
	await turns();
	// Do not save from the new owner here: inspect the automatic late old-response writes themselves.
	await (old as unknown as { saving: Promise<void> }).saving;
	expect(disk).toMatchObject({ settings: { refreshMinutes: 13 }, state: { queue: [{ description: 'New offline action' }], plan: [later] } });
	fresh.onunload();
	await fresh.persist();
});

it('serializes a held old disk write before newer settings and queue writes while activation stays usable', async () => {
	const app = App.createConfigured__({ files: {} });
	const fake = new FakeToggl();
	let disk: unknown = { settings: { refreshMinutes: 5 }, state: { workspaceId: 5 } };
	let hold = false;
	let release!: () => void;
	const load = async (): Promise<TogglMobileTimerPlugin> => {
		vi.resetModules();
		const { default: Plugin } = await import('../src/main');
		const p = new Plugin(app as never, manifest as never);
		vi.spyOn(p, 'loadData').mockImplementation(async () => copy(disk));
		vi.spyOn(p, 'saveData').mockImplementation(async (data: unknown) => {
			if (hold) { hold = false; await new Promise<void>((resolve) => { release = resolve; }); }
			disk = copy(data);
		});
		vi.spyOn(p, 'refreshChrome').mockImplementation(() => undefined);
		vi.spyOn(p, 'registerView').mockImplementation(() => undefined);
		await p.onload();
		return p;
	};
	const old = await load();
	await turns();
	hold = true;
	const oldWrite = old.persist();
	await turns();
	expect(release).toBeTypeOf('function');
	old.onunload();
	const fresh = await load();
	fresh.service.deps.isPro = () => true;
	fresh.service.deps.hasToken = () => true;
	fresh.service.deps.client.opts.getToken = () => 'controlled-fixture';
	fresh.service.deps.client.opts.http = fake.http;
	const { TogglMobileTimerSettingTab } = await import('../src/settings');
	const settingWrite = new TogglMobileTimerSettingTab(app as never, fresh).setControlValue('refreshMinutes', 13);
	expect(await fresh.service.start({ description: 'Local work during disk wait', projectId: null, tags: [] })).toBe(true);
	// Current Pro is checked again when the handoff ends, so nothing is sent after eligibility is lost.
	fresh.service.deps.isPro = () => false;
	const newWrite = fresh.persist();
	expect(fake.calls).toHaveLength(0);
	expect(fresh.pillText()).toMatch(/pending.*queued/);
	release();
	await Promise.all([oldWrite, settingWrite, newWrite]);
	await turns();
	expect(disk).toMatchObject({ settings: { refreshMinutes: 13 }, state: { queue: [{ description: 'Local work during disk wait' }] } });
	expect(fake.calls.filter((r) => r.method === 'POST')).toHaveLength(0);
	fresh.onunload();
	await fresh.persist();
});
