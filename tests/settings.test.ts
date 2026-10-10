import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

describe('normalizeSettings', () => {
	it('repairs bad saved settings', () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ refreshMinutes: 'x' as never, tokenSecretId: 'Bad Id!' as never, defaultProjectId: 5 as never, weekStart: 'friday' as never })).toEqual(DEFAULT_SETTINGS);
	});
	it('keeps good values and clamps the refresh time', () => {
		expect(normalizeSettings({ refreshMinutes: 1 }).refreshMinutes).toBe(5);
		expect(normalizeSettings({ refreshMinutes: 500 }).refreshMinutes).toBe(60);
		expect(normalizeSettings({ defaultProjectId: '123', weekStart: 'sunday', tokenSecretId: 'my-toggl-key' })).toMatchObject({ defaultProjectId: '123', weekStart: 'sunday', tokenSecretId: 'my-toggl-key' });
	});
	it('never has a token field', () => {
		expect(Object.keys(DEFAULT_SETTINGS).join(' ')).not.toMatch(/token(?!SecretId)/i);
	});
});
