import { Notice, Platform, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro } from './pro';
import { formatWait, logHeading } from './logic';
import type TogglMobileTimerPlugin from './main';
import { helloSettingItems } from './hello/settings';

export interface TogglMobileTimerSettings {
	/** Name of the secret in Obsidian secret storage. The token itself is never in data.json. */
	tokenSecretId: string;
	/** Free: one default project for every timer, as a project id text. Empty means no project. */
	defaultProjectId: string;
	showStatusBar: boolean;
	/** True: the title of the open note is the description of a timer that starts from that note, and Toggl gets it. */
	useNoteTitle: boolean;
	/** Minutes before the timer panel asks Toggl again. */
	refreshMinutes: number;
	weekStart: 'monday' | 'sunday';
	noteLogHeading: string;
}

export const REFRESH_MIN = 5;
export const REFRESH_MAX = 60;
export const DEFAULT_SECRET_ID = 'toggl-mobile-timer-api-token';

export const DEFAULT_SETTINGS: TogglMobileTimerSettings = {
	tokenSecretId: DEFAULT_SECRET_ID,
	defaultProjectId: '',
	showStatusBar: true,
	useNoteTitle: true,
	refreshMinutes: 10,
	weekStart: 'monday',
	noteLogHeading: 'Time tracking',
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<TogglMobileTimerSettings> | null | undefined): TogglMobileTimerSettings {
	const s = saved ?? {};
	const minutes = typeof s.refreshMinutes === 'number' && Number.isFinite(s.refreshMinutes) ? Math.round(s.refreshMinutes) : DEFAULT_SETTINGS.refreshMinutes;
	const id = typeof s.tokenSecretId === 'string' && /^[a-z0-9-]+$/.test(s.tokenSecretId) ? s.tokenSecretId : DEFAULT_SETTINGS.tokenSecretId;
	return {
		tokenSecretId: id,
		defaultProjectId: typeof s.defaultProjectId === 'string' && /^\d{0,15}$/.test(s.defaultProjectId) ? s.defaultProjectId : '',
		showStatusBar: typeof s.showStatusBar === 'boolean' ? s.showStatusBar : DEFAULT_SETTINGS.showStatusBar,
		useNoteTitle: typeof s.useNoteTitle === 'boolean' ? s.useNoteTitle : DEFAULT_SETTINGS.useNoteTitle,
		refreshMinutes: Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, minutes)),
		weekStart: s.weekStart === 'sunday' ? 'sunday' : 'monday',
		noteLogHeading: logHeading(s.noteLogHeading),
	};
}

export class TogglMobileTimerSettingTab extends PluginSettingTab {
	plugin: TogglMobileTimerPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: TogglMobileTimerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, normalizeSettings({ ...this.plugin.settings, [key]: value }));
		await this.plugin.persist();
		this.plugin.refreshChrome();
	}

	private budgetText(): string {
		const svc = this.plugin.service;
		const wait = svc.waitMs();
		const left = `Requests left this hour: ${svc.requestsLeft()} of 30 on the Toggl free plan.`;
		return wait > 0 ? `${left} Toggl asks us to wait ${formatWait(wait)}.` : left;
	}

	private projectOptions(): Record<string, string> {
		const out: Record<string, string> = { '': 'No project' };
		for (const p of this.plugin.service.state.projects) if (p.active) out[String(p.id)] = p.name;
		return out;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Toggl API token',
				desc: 'Find it on track.toggl.com under Profile settings, API token. It is kept in Obsidian secret storage, not in a note or in data.json.',
				control: { type: 'secret', key: 'tokenSecretId', defaultValue: DEFAULT_SECRET_ID },
			},
			{
				name: 'Check connection',
				desc: 'Asks Toggl who you are. This uses 1 request.',
				action: () => void this.plugin.checkConnection().then(() => this.update()),
			},
			{
				name: 'Default project',
				desc: 'Every timer you start gets this project. Pro lets you pick a project for each timer and set one in the properties of a note. Load the list first.',
				control: { type: 'dropdown', key: 'defaultProjectId', defaultValue: '', options: this.projectOptions() },
			},
			{
				name: 'Load projects',
				desc: 'Gets your projects from Toggl. This uses 1 request. The list is kept for 6 hours.',
				action: () => void this.plugin.service.loadProjects(true).then((p) => {
					new Notice(`${p.length} projects loaded.`);
					this.update();
				}),
			},
			{
				name: 'Show timer in the status bar',
				desc: 'The status bar does not exist on phones and tablets. There the timer panel and the ribbon button show the timer.',
				visible: () => Platform.isDesktop,
				control: { type: 'toggle', key: 'showStatusBar', defaultValue: true },
			},
			{
				name: 'Use the note title as the description',
				desc: 'On: when you start a timer from a note, the title of the open note is the description of the time entry, and it is sent to Toggl. The Start window offers it, and "Start timer for this note" sends it at once. Off: no note title is sent, unless you type it.',
				control: { type: 'toggle', key: 'useNoteTitle', defaultValue: true },
			},
			{
				name: 'Ask Toggl again after',
				desc: `Minutes before the panel asks Toggl for fresh data when you open the app again, from ${REFRESH_MIN} to ${REFRESH_MAX}. A longer wait uses fewer of your 30 requests an hour.`,
				control: { type: 'slider', key: 'refreshMinutes', defaultValue: DEFAULT_SETTINGS.refreshMinutes, min: REFRESH_MIN, max: REFRESH_MAX, step: 5 },
			},
			{
				name: 'Week starts on',
				desc: 'Used by the week range in the report code block.',
				control: { type: 'dropdown', key: 'weekStart', defaultValue: 'monday', options: { monday: 'Monday', sunday: 'Sunday' } },
			},
			{
				name: 'Note log heading',
				desc: 'Log today to this note adds finished entries under this heading. Open your daily note in edit mode and run the command. A missing heading is added at the end.',
				control: { type: 'text', key: 'noteLogHeading', defaultValue: DEFAULT_SETTINGS.noteLogHeading },
			},
			{ name: 'Request budget', desc: this.budgetText() },
			{
				name: 'Pro features',
				desc: isPro()
					? 'Pro is on: report code block, edit and delete past entries, project and tag pickers, a project for each note, and the offline queue.'
					: 'Free version: start, stop and switch the timer, the running timer and the day total, one default project, and a note log. Pro adds the report code block, edit and delete of past entries, project and tag pickers, a project for each note, and the offline queue.',
			},
		];
	}
}
