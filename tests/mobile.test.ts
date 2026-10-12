import { App, Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TogglMobileTimerPlugin from '../src/main';
import manifest from '../manifest.json';

const saved = { isMobile: Platform.isMobile, isDesktop: Platform.isDesktop };

function phone(): TogglMobileTimerPlugin {
	Object.assign(Platform, { isMobile: true, isDesktop: false });
	return new TogglMobileTimerPlugin(App.createConfigured__({ files: {} }) as never, manifest as never);
}

describe('on a phone', () => {
	afterEach(() => {
		Object.assign(Platform, saved);
		vi.restoreAllMocks();
	});

	it('adds no status bar item, because a phone has no status bar', () => {
		const plugin = phone();
		const bar = vi.spyOn(plugin, 'addStatusBarItem');
		plugin.refreshChrome();
		expect(bar).not.toHaveBeenCalled();
	});

	it('opens the timer panel in a tab, not in the right sidebar', async () => {
		const plugin = phone();
		const tab = vi.spyOn(plugin.app.workspace, 'getLeaf');
		const right = vi.spyOn(plugin.app.workspace, 'getRightLeaf');
		await plugin.openPanel();
		expect(tab).toHaveBeenCalledWith('tab');
		expect(right).not.toHaveBeenCalled();
	});
});
