import { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { StartModal } from '../src/modals';
import type { StartRequest } from '../src/service';

function open(): { input: HTMLInputElement; sent: StartRequest[] } {
	const sent: StartRequest[] = [];
	const modal = new StartModal(App.createConfigured__({ files: {} }), { title: 'Start timer', description: 'Note', projects: [], projectId: null, defaultProjectName: '', tagNames: [], onSubmit: (r) => sent.push(r) });
	modal.open();
	const input = modal.contentEl.querySelector('input');
	if (!input) throw new Error('no description box');
	return { input, sent };
}

describe('StartModal', () => {
	it('Enter starts the timer', () => {
		const { input, sent } = open();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(sent).toEqual([{ description: 'Note', projectId: null, tags: [] }]);
	});

	it('Enter that confirms an input method word does not start the timer', () => {
		const { input, sent } = open();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
		expect(sent).toEqual([]);
	});
});
