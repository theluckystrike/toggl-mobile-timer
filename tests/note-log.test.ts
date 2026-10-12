import { describe, expect, it, vi } from 'vitest';
import type { Editor } from 'obsidian';
import { logHeading, noteLogEdit, type TimeEntry } from '../src/logic';
import TogglMobileTimerPlugin from '../src/main';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

const NOW = Date.parse('2026-10-12T14:00:00Z');
const entry = (patch: Partial<TimeEntry> = {}): TimeEntry => ({ id: 1, workspace_id: 5, description: 'Write README', project_name: 'Docs', start: '2026-10-12T08:30:00Z', stop: '2026-10-12T09:15:00Z', duration: 2700, ...patch });
const apply = (content: string, entries: TimeEntry[] = [entry()], heading = 'Time tracking'): string => {
	const edit = noteLogEdit(content, entries, NOW, 0, heading);
	return content.slice(0, edit.offset) + edit.text + content.slice(edit.offset);
};

describe('note log', () => {
	it('adds a heading and the entry without a note title or token', () => {
		expect(apply('# Daily note\n')).toBe('# Daily note\n\n## Time tracking\n\n- 2026-10-12 08:30 to 2026-10-12 09:15 | Write README | Docs | 0:45:00 <!-- toggl-entry:5:1:2026-10-12 -->\n\n');
	});
	it('adds under the chosen heading before the next section and keeps all note text', () => {
		const before = '# Day\n\n## Work\n\nExisting log.\n\n### Details\n\nKeep this.\n\n## Plans\n\nCall Jo.\n';
		const edit = noteLogEdit(before, [entry()], NOW, 0, 'Work');
		expect(edit.offset).toBe(before.indexOf('## Plans'));
		expect(apply(before, [entry()], 'Work')).toContain('Keep this.\n\n- 2026-10-12');
		expect(apply(before, [entry()], 'Work').endsWith('## Plans\n\nCall Jo.\n')).toBe(true);
	});
	it('supports a level one heading with closing hashes', () => {
		expect(apply('# Time tracking ###\n\n# Other\n')).not.toContain('## Time tracking');
		expect(apply('# Time tracking ###\n\n# Other\n')).toContain('-->\n\n# Other');
	});
	it('ignores a heading in frontmatter, code and a blockquote', () => {
		const text = '---\nexample: |\n  ## Time tracking\n---\n\n```md\n## Time tracking\n```\n\n> ## Time tracking\n';
		expect(apply(text)).toContain('> ## Time tracking\n\n## Time tracking\n');
	});
	it('does not put a log in an unclosed code block or frontmatter', () => {
		for (const text of ['```md\n## Time tracking\n', '---\nexample: bad\n']) expect(noteLogEdit(text, [entry()], NOW, 0, 'Time tracking').count).toBe(0);
	});
	it('marks a note with an unclosed block as blocked, not as a note with no new entries', () => {
		expect(noteLogEdit('```md\n## Time tracking\n', [entry()], NOW, 0, 'Time tracking').blocked).toBe(true);
		expect(noteLogEdit('# Day\n', [], NOW, 0, 'Time tracking').blocked).toBeUndefined();
	});
	it('matches the heading without regard to letter case and adds no second heading', () => {
		const result = apply('## time tracking\n\n## Plans\n');
		expect(result.match(/time tracking/gi)).toHaveLength(1);
		expect(result).toContain('## time tracking\n\n- 2026-10-12 08:30');
	});
	it('preserves CRLF and needs only one insertion', () => {
		const text = '## Time tracking\r\n\r\n## Plans\r\n';
		const result = apply(text);
		expect(result.replace(/\r\n/g, '')).not.toContain('\n');
		expect(result).toContain('-->\r\n\r\n## Plans');
	});
	it('skips a repeat run and adds only entries that are new', () => {
		const text = apply('');
		expect(apply(text)).toBe(text);
		const edit = noteLogEdit(text, [entry(), entry({ id: 2, description: 'Next' })], NOW, 0, 'Time tracking');
		expect(edit.count).toBe(1);
		expect(edit.text).toContain('Next');
		expect(edit.text).not.toContain('Write README');
	});
	it('counts workspace and date in the marker and drops repeated API rows', () => {
		expect(noteLogEdit('', [entry(), entry(), entry({ workspace_id: 6 })], NOW, 0, '').count).toBe(2);
		const old = '<!-- toggl-entry:5:1:2026-10-11 -->';
		expect(noteLogEdit(old, [entry()], NOW, 0, '').count).toBe(1);
	});
	it('skips running, unsent, invalid, future and out of day entries', () => {
		const invalid = [entry({ stop: null, duration: -1 }), entry({ id: -1 }), entry({ id: 1.5 }), entry({ workspace_id: 0 }), entry({ start: 'bad' }), entry({ stop: 'bad' }), entry({ stop: '2026-10-12T08:00:00Z' }), entry({ stop: '2026-10-12T15:00:00Z' }), entry({ start: '2026-10-11T08:30:00Z', stop: '2026-10-11T09:15:00Z' })];
		expect(noteLogEdit('Keep me', invalid, NOW, 0, '').count).toBe(0);
		expect(apply('Keep me', invalid)).toBe('Keep me');
	});
	it('clips an overnight entry to the local day', () => {
		const edit = noteLogEdit('', [entry({ start: '2026-10-11T16:30:00Z', stop: '2026-10-11T18:00:00Z', duration: 5400 })], NOW, 420, 'Time tracking');
		expect(edit.count).toBe(1);
		expect(edit.text).toContain('2026-10-12 00:00 to 2026-10-12 01:00');
		expect(edit.text).toContain('| 1:00:00');
	});
	it('sorts oldest first without changing the cached array', () => {
		const entries = [entry({ id: 2, start: '2026-10-12T10:00:00Z', stop: '2026-10-12T11:00:00Z', description: 'Later' }), entry()];
		const edit = noteLogEdit('', entries, NOW, 0, 'Time tracking');
		expect(edit.text.indexOf('Write README')).toBeLessThan(edit.text.indexOf('Later'));
		expect(entries[0]?.id).toBe(2);
	});
	it('escapes Markdown and HTML and keeps descriptions on one line', () => {
		const text = apply('', [entry({ description: '<img>\n[[Secret]] *work* | `code`', project_name: '# Docs' })]);
		expect(text).toContain('\\<img\\> \\[\\[Secret\\]\\] \\*work\\* \\| \\`code\\`');
		expect(text).toContain('\\# Docs');
		expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
	});
	it('uses labels for missing description and project', () => {
		expect(apply('', [entry({ description: null, project_name: null })])).toContain('\\(no description\\) | \\(no project\\)');
	});
	it('normalizes the heading and uses the same heading after it is escaped', () => {
		expect(logHeading('  ## Work\nlog  ')).toBe('Work log');
		expect(logHeading('')).toBe('Time tracking');
		expect(logHeading('x'.repeat(100))).toHaveLength(80);
		expect(normalizeSettings({ noteLogHeading: null as never }).noteLogHeading).toBe(DEFAULT_SETTINGS.noteLogHeading);
		const result = apply('', [entry()], 'Work *log*');
		expect(apply(result, [entry({ id: 2 })], 'Work *log*').match(/## Work/g)).toHaveLength(1);
	});
	it('the free command writes through the editor once and sends no request', () => {
		let text = '# Daily note\n';
		const editor = {
			getValue: () => text,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn((addition: string, pos: { line: number; ch: number }) => { text = text.slice(0, pos.ch) + addition + text.slice(pos.ch); }),
		} as unknown as Editor;
		const plugin = Object.create(TogglMobileTimerPlugin.prototype) as TogglMobileTimerPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS };
		const request = vi.fn();
		plugin.service = { noteLogEntries: () => [entry()], deps: { now: () => NOW, tzOffsetMin: () => 0, client: { call: request } } } as never;
		plugin.logToday(editor);
		plugin.logToday(editor);
		expect(text).toContain('Write README');
		expect(editor.replaceRange).toHaveBeenCalledTimes(1);
		expect(request).not.toHaveBeenCalled();
	});
});
