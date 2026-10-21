import { buildSync } from 'esbuild';
import * as obsidian from 'obsidian';
import { describe, expect, it } from 'vitest';
import type TogglMobileTimerPlugin from '../src/main';
import { TimerSession } from '../src/lifecycle';
import { FakeToggl } from './fake-toggl';
import manifest from '../manifest.json';

const copy = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
const turns = async (count = 150): Promise<void> => { for (let i = 0; i < count; i++) await Promise.resolve(); };
// Evaluate synchronously: async module imports add microtasks and can hide the completion boundary.
const bundle = buildSync({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
	external: ['obsidian', '*license/github-obsidian'] }).outputFiles[0]!.text;

function environment() {
	let disk: unknown = { settings: { refreshMinutes: 5 }, state: { workspaceId: 5 } };
	const owners: TogglMobileTimerPlugin[] = [];
	class HostPlugin {
		constructor(public app: unknown, public manifest: unknown) {}
		async loadData(): Promise<unknown> { return copy(disk); }
		async saveData(data: unknown): Promise<void> { disk = copy(data); }
		addSettingTab(): void {} register(): void {} registerView(): void {} addRibbonIcon(): null { return null; }
		addCommand(): void {} registerMarkdownCodeBlockProcessor(): void {} registerEvent(): void {}
		registerInterval(): void {} registerDomEvent(): void {}
	}
	const workspace = { onLayoutReady: () => undefined, getLeavesOfType: () => [] };
	const app = { secretStorage: { getSecret: () => null }, workspace };
	return {
		owners,
		async load() {
			const mod = { exports: {} as { default: typeof TogglMobileTimerPlugin } };
			const require = (id: string): unknown => {
				if (id === 'obsidian') return { ...obsidian, Plugin: HostPlugin };
				if (id.endsWith('license/github-obsidian')) return {
					createGitHubSponsors: () => ({ init: () => undefined, onChange: () => () => undefined, isPro: () => false, refresh: async () => undefined }),
					sponsorsSettingItems: () => [],
				};
				throw new Error(`Unexpected dependency ${id}`);
			};
			new Function('require', 'module', 'exports', bundle)(require, mod, mod.exports);
			const p = new mod.exports.default(app as never, manifest as never);
			p.refreshChrome = () => undefined;
			await p.onload();
			owners.push(p);
			return { p };
		},
		async close() { for (const p of owners) p.onunload(); await owners.at(-1)?.persist(); await turns(); },
	};
}

describe('handoff completion ownership', () => {
	it.each([2, 3, 12])('keeps the latest of %i actual plugin evaluations usable at all 20 activation offsets', async (activations) => {
		for (let delay = 0; delay < 20; delay++) {
			const env = environment();
			try {
				let latest!: TogglMobileTimerPlugin;
				for (let i = 0; i < activations; i++) {
					if (latest) latest.onunload();
					const previous = latest;
					latest = (await env.load()).p;
					if (previous) expect(latest.constructor).not.toBe(previous.constructor);
					for (let j = 0; j < delay; j++) await Promise.resolve();
				}
				await turns();
				expect(latest.service.deps.isWaiting?.(), `offset ${delay}`).toBe(false);
				expect(latest.pillText()).not.toMatch(/pending/);
				const fake = new FakeToggl();
				latest.service.deps.isPro = () => true;
				latest.service.deps.hasToken = () => true;
				latest.service.deps.client.opts.getToken = () => 'controlled-fixture';
				latest.service.deps.client.opts.http = fake.http;
				expect(await latest.service.start({ description: `Usable ${activations}/${delay}`, projectId: null, tags: [] })).toBe(true);
				expect(fake.calls.filter((r) => r.method === 'POST')).toHaveLength(1);
				expect(await latest.service.refresh({ force: true })).toBe(true);
				expect(fake.calls.some((r) => r.method === 'GET')).toBe(true);
				expect(latest.service.pending()).toBe(0);
				const count = fake.calls.length;
				for (const old of env.owners.slice(0, -1)) await old.service.refresh({ force: true });
				expect(fake.calls).toHaveLength(count);
			} finally { await env.close(); }
		}
	});

	it.each(['sync', 'microtask', 'nested microtask'] as const)('drains a new claim from the final resume via %s', async (timing) => {
		const session = new TimerSession(null);
		const resumed: number[] = [];
		let activeWrites = 0;
		let maxWrites = 0;
		const owner = (id: number) => ({
			settled: async () => undefined,
			write: async () => { maxWrites = Math.max(maxWrites, ++activeWrites); await Promise.resolve(); activeWrites--; },
			resume: () => { resumed.push(id); }, failed: () => { throw new Error('Unexpected save failure'); },
		});
		const second = owner(2);
		const first = owner(1);
		first.resume = () => {
			resumed.push(1);
			if (timing === 'sync') session.claim(second);
			else queueMicrotask(() => {
				if (timing === 'microtask') session.claim(second);
				else queueMicrotask(() => session.claim(second));
			});
		};
		session.claim(first);
		await turns();
		expect(resumed).toEqual([1, 2]);
		expect(maxWrites).toBe(1);
	});

	it('keeps one drain while 1000 intermediate owners retire behind an issued operation', async () => {
		const session = new TimerSession(null);
		let release!: () => void;
		const issued = new Promise<void>((resolve) => { release = resolve; });
		const resumed: number[] = [];
		let writes = 0;
		const owner = (id: number, settled = async () => undefined) => ({
			settled, write: async () => { writes++; }, resume: () => { resumed.push(id); },
			failed: () => { throw new Error('Unexpected save failure'); },
		});
		session.claim(owner(0, () => issued));
		await turns();
		const boundary = session as unknown as { handoff: Promise<void> | null; retiring: Set<Promise<void>> };
		session.claim(owner(1));
		const drain = boundary.handoff;
		for (let i = 2; i <= 1000; i++) session.claim(owner(i));
		await turns();
		expect(boundary.handoff).toBe(drain);
		expect(boundary.retiring.size).toBe(1);
		expect(resumed).toEqual([0]);
		expect(writes).toBe(1);
		release();
		await turns();
		expect(resumed).toEqual([0, 1000]);
		expect(boundary.retiring.size).toBe(0);
		expect(boundary.handoff).toBeNull();
	});

	it('waits for a tail owner save, then resumes only the newer claimant with current data', async () => {
		const session = new TimerSession(null);
		const resumed: number[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const saved: number[] = [];
		const first = {
			settled: async () => undefined, write: async () => undefined,
			resume: () => { resumed.push(1); queueMicrotask(() => session.claim(second)); },
			failed: () => { throw new Error('Unexpected save failure'); },
		};
		const second = { ...first, write: async () => { await held; }, resume: () => { resumed.push(2); } };
		session.claim(first);
		await turns();
		expect(resumed).toEqual([1]);
		session.data.settings.refreshMinutes = 19;
		session.claim({ ...first, write: async (data) => { saved.push(data.settings.refreshMinutes); }, resume: () => { resumed.push(3); } });
		await turns();
		expect(resumed).toEqual([1]);
		expect(saved).toEqual([]);
		release();
		await turns();
		expect(resumed).toEqual([1, 3]);
		expect(saved).toEqual([19]);
	});
});
