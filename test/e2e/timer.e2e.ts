import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';

// Real-app checks against a STUBBED Toggl (test/e2e/stub-toggl.js): no real token, no real request. The stub also fixes the
// clock at 14:00 local time, so the day total is the same on each run: 3 entries, 160 minutes. Pro is switched on with a
// stubbed GitHub Sponsors answer ($5 a month), the same way as in the other products.
const STUB = readFileSync('test/e2e/stub-toggl.js', 'utf8');
const TOKEN = 'stub-token-0000';
const FAKE = transformSync(readFileSync('tests/fake-toggl.ts', 'utf8').replace('export class FakeToggl', 'class FakeToggl'), { loader: 'ts' }).code;

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
	auth: string;
}

const calls = (): Promise<Call[]> => browser.execute(() => ((window as unknown as { __tmtStub: { calls: Call[] } }).__tmtStub.calls));
const setMode = (mode: string): Promise<void> => browser.execute((m: string) => void ((window as unknown as { __tmtStub: { mode: string } }).__tmtStub.mode = m), mode);

async function installStub(): Promise<void> {
	await browser.executeObsidian(({ app }, src) => new Function('app', `return ${src}`)(app) as string, STUB);
}

/** Runs js in the app with the plugin as p. Returns the JSON-safe result. */
async function inPlugin<T>(js: string): Promise<T> {
	return browser.executeObsidian(({ app }, id, code) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
		return new Function('app', 'p', `return (${code})`)(app, p) as T;
	}, pluginId, js);
}

async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, value) => {
			interface Pro {
				opts: { http: unknown };
				refreshNow(): Promise<void>;
				signOut(): void;
			}
			const p = (app as unknown as { plugins: { plugins: Record<string, { pro: Pro }> } }).plugins.plugins[id]!;
			if (!value) {
				p.pro.signOut();
				return;
			}
			const reply = { status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
			p.pro.opts.http = () => Promise.resolve(reply);
			app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
			await p.pro.refreshNow();
		},
		pluginId,
		on,
	);
}

/** Forgets the budget of both buckets and the 402 block, so the next test starts clean. */
async function freshBudget(): Promise<void> {
	await inPlugin<string>("(() => { for (const b of [p.service.deps.client.budgets.user, p.service.deps.client.budgets.org]) { b.remaining = null; b.resetsAtMs = null; b.blockedUntilMs = 0; b.failures = 0; b.sent = []; } return 'ok'; })()");
}

async function openPreview(path: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, file) => {
		const f = app.vault.getFileByPath(file);
		if (f) await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'preview' } });
	}, path);
}

const count = (sel: string): Promise<number> => browser.execute((q: string) => document.querySelectorAll(q).length, sel);
const texts = (sel: string): Promise<string[]> => browser.execute((q: string) => Array.from(document.querySelectorAll(q)).map((e) => e.textContent ?? ''), sel);

const state = (): Promise<{ status: string; current: string | null; today: number; pending: number }> =>
	inPlugin("({ status: p.service.status(), current: p.service.current()?.description ?? null, today: p.service.todaySeconds(), pending: p.service.pending() })");

describe(`${pluginId} in the real app`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const s = await reloadPlugin(pluginId);
		expect(s).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('has no token on a new install and sends no request', async function () {
		expect((await state()).status).toBe('nolink');
		const sent = await inPlugin<boolean>('p.service.start({ description: "x", projectId: null, tags: [] })');
		expect(sent).toBe(false);
	});
});

describe(`${pluginId} free tier with a stubbed Toggl`, function () {
	before(async function () {
		await setPro(false);
		await installStub();
	});

	it('one background refresh costs one request and gives the day total of 2 h 40 min', async function () {
		await inPlugin<boolean>('p.service.refresh({ force: true, background: true })');
		const c = await calls();
		expect(c).toHaveLength(1);
		expect(c[0]?.path).toMatch(/^\/me\/time_entries\?meta=true&start_date=/);
		expect(c[0]?.auth).toBe(`Basic ${Buffer.from(`${TOKEN}:api_token`).toString('base64')}`);
		const s = await state();
		expect(s.today).toBe(9600);
		expect(s.current).toBeNull();
	});

	it('keeps the token out of data.json', async function () {
		await inPlugin<string>("(p.persist(), 'ok')");
		await browser.pause(300);
		const raw = await browser.executeObsidian(({ app }, id) => app.vault.adapter.read(`.obsidian/plugins/${id}/data.json`), pluginId);
		expect(raw).not.toContain(TOKEN);
		expect(raw).toContain('tokenSecretId');
	});

	it('logs finished entries to the daily note for free, sends no request and skips a second copy', async function () {
		await browser.executeObsidian(async ({ app }) => {
			const path = 'Notes/Time log.md';
			const file = app.vault.getFileByPath(path) ?? await app.vault.create(path, '# Daily log\n\n## Time tracking\n\n## Plans\n\nKeep this.\n');
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'source' } });
		});
		const before = (await calls()).length;
		await browser.executeObsidianCommand(`${pluginId}:log-today`);
		const first = await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.getValue() ?? '');
		expect(first).toContain('Write README');
		expect(first).toContain('Fix sync bug');
		expect(first).toContain('Review notes');
		expect(first.match(/<!-- toggl-entry:/g)).toHaveLength(3);
		expect(first.indexOf('Write README')).toBeLessThan(first.indexOf('## Plans'));
		expect(first).toContain('Keep this.');
		await browser.executeObsidianCommand(`${pluginId}:log-today`);
		expect(await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.getValue() ?? '')).toBe(first);
		expect((await calls()).length).toBe(before);
	});

	it('the note log insertion can be undone in one step', async function () {
		await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.undo());
		expect(await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.getValue() ?? '')).toBe('# Daily log\n\n## Time tracking\n\n## Plans\n\nKeep this.\n');
	});

	it('Start timer opens a modal; typing a description and selecting Start sends one POST', async function () {
		await browser.executeObsidianCommand(`${pluginId}:start`);
		await browser.$('.tmt-modal input').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('.tmt-modal input')!;
			input.value = 'Draft the release notes';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector<HTMLButtonElement>('.tmt-modal button.mod-cta')!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'POST'), { timeout: 8000, timeoutMsg: 'no POST' });
		const post = (await calls()).find((c) => c.method === 'POST')!;
		expect(post.path).toBe('/workspaces/5/time_entries?meta=true');
		expect(post.body).toMatchObject({ description: 'Draft the release notes', duration: -1, workspace_id: 5, created_with: 'Mobile Timer for Toggl Track' });
		expect(post.body).not.toHaveProperty('project_id');
		expect((await state()).current).toBe('Draft the release notes');
	});

	it('shows the running timer in the status bar and in the panel', async function () {
		await browser.waitUntil(async () => (await browser.$('.status-bar .tmt-status').getText()).includes('Draft the release notes'), { timeout: 5000 });
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-pill-text')).some((t) => t.includes('Draft the release notes')), { timeout: 8000, timeoutMsg: 'panel pill text' });
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-today')).some((t) => /^Today 2h 4\dm$/.test(t)), { timeout: 8000, timeoutMsg: 'panel day total' });
		expect(await count('.tmt-panel .tmt-row')).toBe(3);
		expect(await count('.tmt-panel .tmt-edit')).toBe(0);
	});

	it('Stop sends one PATCH and the entry joins the list', async function () {
		const before = (await calls()).length;
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
		const c = (await calls()).slice(before);
		expect(c.map((x) => x.method)).toEqual(['PATCH']);
		expect(c[0]?.path).toMatch(/^\/workspaces\/5\/time_entries\/\d+\/stop/);
		expect(await count('.tmt-panel .tmt-row')).toBe(4);
	});

	it('Start timer for this note uses the note name and, without Pro, ignores the toggl-project property', async function () {
		await obsidianPage.openFile('Notes/Project plan.md');
		await browser.pause(500);
		await browser.executeObsidianCommand(`${pluginId}:start-note`);
		await browser.waitUntil(async () => (await state()).current === 'Project plan', { timeout: 8000 });
		const post = (await calls()).filter((c) => c.method === 'POST').at(-1)!;
		expect(post.body).not.toHaveProperty('project_id');
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
	});

	it('HTTP 402 stops all requests until the wait ends and the pill says so', async function () {
		await setMode('402');
		const before = (await calls()).length;
		for (let i = 0; i < 6; i++) await inPlugin<boolean>('p.service.refresh({ force: true })');
		expect((await calls()).length - before).toBe(1);
		expect((await state()).status).toBe('limited');
		expect(await inPlugin<string>('p.pillText()')).toMatch(/^Toggl limit reached, retry in \d+ min$/);
		await setMode('ok');
		await freshBudget();
	});

	it('HTTP 429 backs off the same way', async function () {
		await setMode('429');
		const before = (await calls()).length;
		for (let i = 0; i < 4; i++) await inPlugin<boolean>('p.service.refresh({ force: true })');
		expect((await calls()).length - before).toBe(1);
		await setMode('ok');
		await freshBudget();
	});

	it('without Pro an offline start changes nothing', async function () {
		await setMode('offline');
		const ok = await inPlugin<boolean>('p.service.start({ description: "Offline", projectId: null, tags: [] })');
		expect(ok).toBe(false);
		const s = await state();
		expect(s.pending).toBe(0);
		expect(s.current).toBeNull();
		await setMode('ok');
		await freshBudget();
	});

	it('the report block is locked and sends no request', async function () {
		const before = (await calls()).length;
		await openPreview('Notes/Locked report.md');
		await browser.$('.tmt-locked').waitForExist({ timeout: 5000 });
		expect((await texts('.tmt-locked')).some((t) => /pro feature/.test(t))).toBe(true);
		expect((await calls()).length).toBe(before);
	});
});

describe(`${pluginId} Pro tier with a stubbed Toggl and a stubbed GitHub`, function () {
	before(async function () {
		await setPro(true);
		await freshBudget();
	});
	after(async function () {
		await setPro(false);
	});

	it('the report block shows hours by project and by day from one request', async function () {
		await inPlugin<boolean>('p.service.refresh({ force: true })');
		const before = (await calls()).filter((c) => c.path.includes('start_date')).length;
		await openPreview('Notes/Weekly report.md');
		await browser.waitUntil(async () => (await count('.tmt-report-table')) >= 2, { timeout: 8000, timeoutMsg: 'two report tables expected' });
		const rows = await browser.execute(() => Array.from(document.querySelectorAll('.tmt-report-table tr')).map((r) => r.textContent ?? ''));
		expect(rows.some((t) => t.includes('Docs') && t.endsWith('1.42'))).toBe(true);
		expect(rows.some((t) => t.includes('Code') && t.endsWith('1.25'))).toBe(true);
		expect(rows.filter((t) => t.startsWith('Total')).every((t) => t.endsWith('2.67'))).toBe(true);
		expect((await calls()).filter((c) => c.path.includes('start_date')).length - before).toBe(1);
	});

	it('the toggl-project property sets the project of a timer started from a note', async function () {
		await inPlugin<string>("(p.service.loadProjects(true), 'ok')");
		await browser.pause(400);
		await obsidianPage.openFile('Notes/Project plan.md');
		await browser.pause(600);
		await browser.executeObsidianCommand(`${pluginId}:start-note`);
		await browser.waitUntil(async () => (await state()).current === 'Project plan', { timeout: 8000 });
		const post = (await calls()).filter((c) => c.method === 'POST').at(-1)!;
		expect(post.body).toMatchObject({ description: 'Project plan', project_id: 12 });
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
	});

	it('offline start and stop wait in the queue and go out as ONE request', async function () {
		await setMode('offline');
		await inPlugin<boolean>('p.service.start({ description: "Offline work", projectId: 11, tags: [] })');
		expect((await state()).current).toBe('Offline work');
		await browser.pause(1200);
		await inPlugin<boolean>('p.service.stop()');
		const s = await state();
		expect(s.pending).toBe(2);
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.$('.tmt-queue').waitForExist({ timeout: 5000 });
		expect(await browser.$('.tmt-queue').getText()).toMatch(/2 changes wait/);
		await setMode('ok');
		await freshBudget();
		const before = (await calls()).length;
		await inPlugin<number>('p.service.flushQueue()');
		const sent = (await calls()).slice(before);
		const posts = sent.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ description: 'Offline work', project_id: 11 });
		expect(posts[0]?.body).toHaveProperty('stop');
		expect((await state()).pending).toBe(0);
	});

	it('edit and delete work from the panel', async function () {
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.$('.tmt-panel .tmt-edit').waitForExist({ timeout: 5000 });
		await browser.execute(() => document.querySelector<HTMLButtonElement>('.tmt-panel .tmt-edit')!.click());
		await browser.$('.tmt-modal').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('.tmt-modal input')!;
			input.value = 'Renamed entry';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent === 'Save')!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'PUT'), { timeout: 8000 });
		const put = (await calls()).filter((c) => c.method === 'PUT').at(-1)!;
		expect(put.body).toMatchObject({ description: 'Renamed entry' });
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-desc')).includes('Renamed entry'), { timeout: 5000 });
		const n = await count('.tmt-panel .tmt-row');
		await browser.execute(() => document.querySelector<HTMLButtonElement>('.tmt-panel .tmt-edit')!.click());
		await browser.$('.tmt-modal').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const del = Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent === 'Delete')!;
			del.click();
			Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent?.startsWith('Select again'))!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'DELETE'), { timeout: 8000 });
		await browser.waitUntil(async () => (await count('.tmt-panel .tmt-row')) === n - 1, { timeout: 5000 });
	});

	it('turning Pro off hides the edit buttons', async function () {
		await setPro(false);
		await browser.waitUntil(async () => (await count('.tmt-panel .tmt-edit')) === 0, { timeout: 5000 });
	});
});


describe(`${pluginId} replay lifecycle`, function () {
	it('disabling during a replay keeps unsent changes on disk and after reload', async function () {
		const result = await browser.executeObsidian(async ({ app }, id) => {
			// Controlled service transport only: no real token, sign-in or Toggl request.
			return await new Function('app', 'id', `return (async () => {
				const p = app.plugins.plugins[id];
				const svc = p.service;
				const requests = [];
				let release;
				svc.deps.isPro = () => true;
				svc.deps.hasToken = () => true;
				svc.deps.client.opts.getToken = () => 'lifecycle-fixture';
				svc.deps.client.opts.http = (r) => {
					requests.push(r.method);
					return requests.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ status: 200, json: null, headers: {} });
				};
				for (const b of Object.values(svc.deps.client.budgets)) Object.assign(b, { remaining: null, resetsAtMs: null, blockedUntilMs: 0, failures: 0, sent: [] });
				const t = Date.now();
				const unsent = { step: 'create', startMs: t, stopMs: t + 60000, description: 'Lifecycle unsent fixture', projectId: null, tags: [] };
				svc.state.workspaceId = 5;
				svc.state.queue = [];
				svc.state.plan = [{ step: 'stop', workspaceId: 5, entryId: 7, startMs: t - 60000, atMs: t }, unsent];
				p.settings.tokenSecretId = 'lifecycle-missing-fixture';
				const replay = svc.flushQueue();
				await app.plugins.disablePlugin(id);
				release({ status: 200, json: null, headers: {} });
				const sent = await replay;
				await p.saving;
				const disk = JSON.parse(await app.vault.adapter.read('.obsidian/plugins/' + id + '/data.json'));
				await app.plugins.enablePlugin(id);
				const reloaded = app.plugins.plugins[id].service.state.plan;
				return { requests, sent, diskPlan: disk.state.plan, reloaded, unsent };
			})()`)(app, id) as { requests: string[]; sent: number; diskPlan: unknown[]; reloaded: unknown[]; unsent: unknown };
		}, pluginId);
		const installed = await browser.executeObsidian(async ({ app, obsidian }, id) => {
			const digest = async (name: string): Promise<string> => {
				const bytes = await app.vault.adapter.readBinary(`.obsidian/plugins/${id}/${name}`);
				const hash = await crypto.subtle.digest('SHA-256', bytes);
				return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
			};
			return { apiVersion: obsidian.apiVersion, mainSha256: await digest('main.js'), manifestSha256: await digest('manifest.json'), stylesSha256: await digest('styles.css') };
		}, pluginId);
		const sha = (name: string): string => createHash('sha256').update(readFileSync(name)).digest('hex');
		expect(installed.apiVersion).toMatch(/^1\.(13\.4|1[4-9]\.\d+)$/);
		expect(installed.mainSha256).toBe(sha('main.js'));
		expect(installed.manifestSha256).toBe(sha('manifest.json'));
		expect(installed.stylesSha256).toBe(sha('styles.css'));
		const candidateLockFile = existsSync('package-lock.json') ? 'package-lock.json' : '../../pnpm-lock.yaml';
		console.log('TOGGL_LIFECYCLE_APP_EVIDENCE ' + JSON.stringify({ ...installed, candidateLockFile, candidateLockSha256: sha(candidateLockFile), result }));
		expect(result.requests).toEqual(['PUT']);
		expect(result.sent).toBe(1);
		expect(result.diskPlan).toEqual([result.unsent]);
		expect(result.reloaded).toEqual([result.unsent]);
	});
});

it('immediate actual re-enable keeps a pending create unique and preserves newer settings and UNSENT work', async function () {
	const result = await browser.executeObsidian(async ({ app }, id, fixture) => {
		return await new Function('app', 'id', 'fixture', `return (async () => {
			const fake = new Function(fixture + '; return new FakeToggl();')();
			const old = app.plugins.plugins[id];
			const requests = [];
			const t = Date.now();
			const first = { step: 'create', startMs: t, stopMs: t + 60000, description: 'Immediate known create', projectId: null, tags: [] };
			const later = { ...first, startMs: t + 60000, stopMs: t + 120000, description: 'Immediate later work' };
			let release;
			const eligible = (p, http) => {
				p.pro.isPro = () => true;
				p.service.deps.isPro = () => true;
				p.service.deps.hasToken = () => true;
				p.service.deps.now = () => t + 180000;
				p.service.deps.client.opts.getToken = () => 'controlled-fixture';
				p.service.deps.client.opts.http = http;
			};
			const transport = async r => { requests.push({ method: r.method, description: r.body ? JSON.parse(r.body).description : null }); return fake.http(r); };
			eligible(old, async r => { const reply = await transport(r); return new Promise(resolve => { release = () => resolve(reply); }); });
			for (const b of Object.values(old.service.deps.client.budgets)) Object.assign(b, { remaining: null, resetsAtMs: null, blockedUntilMs: 0, failures: 0, sent: [] });
			old.service.state.workspaceId = 5;
			old.service.state.entries = [];
			old.service.state.queue = [];
			old.service.state.queueBase = null;
			old.service.state.plan = [first, later];
			old.settings.refreshMinutes = 5;
			old.settings.tokenSecretId = 'immediate-missing-fixture';
			const replay = old.service.flushQueue();
			for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
			if (!release) throw new Error('First create did not reach controlled transport');
			await app.plugins.disablePlugin(id);
			await old.persist();
			await app.plugins.enablePlugin(id);
			const fresh = app.plugins.plugins[id];
			eligible(fresh, transport);
			fresh.onProChange();
			await fresh.service.flushQueue();
			const beforeSettle = { requests: [...requests], entries: fake.entries.length, pill: fresh.pillText(), constructorReloaded: old.constructor !== fresh.constructor };
			await fresh.settingTab.setControlValue('refreshMinutes', 13);
			await fresh.service.start({ description: 'Immediate new UNSENT action', projectId: null, tags: [] });
			await fresh.persist();
			const before = JSON.parse(await app.vault.adapter.read('.obsidian/plugins/' + id + '/data.json'));
			fake.mode = 'offline';
			release();
			const sent = await replay;
			for (let i = 0; i < 100; i++) await Promise.resolve();
			await old.saving;
			await fresh.saving;
			const after = JSON.parse(await app.vault.adapter.read('.obsidian/plugins/' + id + '/data.json'));
			const retained = { refreshMinutes: after.settings.refreshMinutes, queue: after.state.queue.map(q => q.description), plan: after.state.plan.map(p => p.description) };
			fake.mode = 'ok';
			for (const b of Object.values(fresh.service.deps.client.budgets)) Object.assign(b, { blockedUntilMs: 0, remaining: null, sent: [] });
			await fresh.service.flushQueue();
			await fresh.persist();
			return { beforeSettle, before: { refreshMinutes: before.settings.refreshMinutes, queue: before.state.queue.map(q => q.description) }, retained, sent, entries: fake.entries.map(e => e.description), pending: fresh.service.pending(), requests };
		})()`)(app, id, fixture) as { beforeSettle: { requests: unknown[]; entries: number; pill: string; constructorReloaded: boolean }; before: { refreshMinutes: number; queue: string[] }; retained: { refreshMinutes: number; queue: string[]; plan: string[] }; sent: number; entries: string[]; pending: number; requests: unknown[] };
	}, pluginId, FAKE);
	const installed = await browser.executeObsidian(async ({ app, obsidian }, id) => {
		const bytes = await app.vault.adapter.readBinary(`.obsidian/plugins/${id}/main.js`);
		const hash = await crypto.subtle.digest('SHA-256', bytes);
		return { apiVersion: obsidian.apiVersion, mainSha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('') };
	}, pluginId);
	const sha = (name: string): string => createHash('sha256').update(readFileSync(name)).digest('hex');
	const candidateLockFile = existsSync('package-lock.json') ? 'package-lock.json' : '../../pnpm-lock.yaml';
	console.log('TOGGL_LIFECYCLE_CORRECTION_APP_EVIDENCE ' + JSON.stringify({ ...installed, candidateLockSha256: sha(candidateLockFile), result }));
	expect(installed.mainSha256).toBe(sha('main.js'));
	expect(result.beforeSettle.requests).toHaveLength(1);
	expect(result.beforeSettle.entries).toBe(1);
	expect(result.beforeSettle.constructorReloaded).toBe(true);
	expect(result.beforeSettle.pill).toMatch(/pending.*queued/);
	expect(result.before).toEqual({ refreshMinutes: 13, queue: ['Immediate new UNSENT action'] });
	expect(result.retained).toEqual({ refreshMinutes: 13, queue: ['Immediate new UNSENT action'], plan: ['Immediate later work'] });
	expect(result.sent).toBe(1);
	expect(result.entries).toEqual(['Immediate known create', 'Immediate later work', 'Immediate new UNSENT action']);
	expect(result.pending).toBe(0);
});


it('rapid actual toggles leave the latest service ready for a new POST and refresh', async function () {
	const observations = [];
	for (const activations of [2, 3, 8]) {
		const reloads = await browser.executeObsidian(async ({ app }, id, count) => {
			return await new Function('app', 'id', 'count', `return (async () => {
				let previous = app.plugins.plugins[id];
				let changed = 0;
				previous.settings.tokenSecretId = 'rapid-missing-fixture';
				for (let i = 0; i < count; i++) {
					await app.plugins.disablePlugin(id);
					await app.plugins.enablePlugin(id);
					const current = app.plugins.plugins[id];
					if (current.constructor !== previous.constructor) changed++;
					previous = current;
				}
				return changed;
			})()`)(app, id, count) as number;
		}, pluginId, activations);
		// Native file IO and plugin-manager scheduling are observable here, not an exact Promise-turn offset.
		await browser.waitUntil(async () => await inPlugin<boolean>('!p.waiting'), { timeout: 8000, timeoutMsg: 'latest owner remained paused after rapid toggles' });
		const usable = await browser.executeObsidian(async ({ app }, id, fixture, count) => {
			return await new Function('app', 'id', 'fixture', 'count', `return (async () => {
				const p = app.plugins.plugins[id];
				const fake = new Function(fixture + '; return new FakeToggl();')();
				p.service.deps.isPro = () => true;
				p.service.deps.hasToken = () => true;
				p.service.deps.client.opts.getToken = () => 'controlled-fixture';
				p.service.deps.client.opts.http = fake.http;
				for (const b of Object.values(p.service.deps.client.budgets)) Object.assign(b, { blockedUntilMs: 0, remaining: null, sent: [] });
				p.service.state.workspaceId = 5;
				const started = await p.service.start({ description: 'Rapid usable ' + count, projectId: null, tags: [] });
				const refreshed = await p.service.refresh({ force: true });
				await p.persist();
				return { waiting: p.waiting, started, refreshed, pending: p.service.pending(), posts: fake.calls.filter(r => r.method === 'POST').length, gets: fake.calls.filter(r => r.method === 'GET').length, descriptions: fake.entries.map(e => e.description) };
			})()`)(app, id, fixture, count) as { waiting: boolean; started: boolean; refreshed: boolean; pending: number; posts: number; gets: number; descriptions: string[] };
		}, pluginId, FAKE, activations);
		expect(reloads).toBe(activations);
		expect(usable).toMatchObject({ waiting: false, started: true, refreshed: true, pending: 0, posts: 1, descriptions: [`Rapid usable ${activations}`] });
		expect(usable.gets).toBeGreaterThan(0);
		observations.push({ activations, reloads, ...usable });
	}
	console.log('TOGGL_HANDOFF_NATIVE_EVIDENCE ' + JSON.stringify({ observations, timing: 'Actual native plugin-manager disable/enable and file IO; no exact microtask-offset claim' }));
});
