import { normalizeState, type TimerState } from './service';
import { normalizeSettings, type TogglMobileTimerSettings } from './settings';

interface Data {
	settings: TogglMobileTimerSettings;
	state: TimerState;
}
interface Owner {
	settled: () => Promise<void>;
	write: (data: Data) => Promise<void>;
	resume: () => void;
	failed: () => void;
}

/** One live data owner per App, including across plugin module reloads. No token is retained here. */
export class TimerSession {
	readonly data: Data;
	private owner: Owner | null = null;
	private saving: Promise<void> = Promise.resolve();
	private handoff: Promise<void> | null = null;
	private claimed = false;
	private retiring = new Set<Promise<void>>();

	constructor(raw: { settings?: Partial<TogglMobileTimerSettings>; state?: unknown } | null) {
		this.data = { settings: normalizeSettings(raw?.settings), state: normalizeState(raw?.state) };
	}

	claim(owner: Owner): void {
		const previous = this.owner;
		this.owner = owner;
		this.claimed = true;
		// Activation itself does not wait for HTTP. Remote work stays paused, local queued work remains usable.
		if (previous) {
			const retired = previous.settled();
			this.retiring.add(retired);
			void retired.then(() => this.retiring.delete(retired), () => this.retiring.delete(retired));
		}
		// One drain loop, not a chain retaining every intermediate plugin while an old request is pending.
		this.drain();
	}

	private drain(): void {
		this.handoff ??= this.finishHandoff().finally(() => {
			this.handoff = null;
			// A claim can arrive after the last owner check, while the completed drain still occupies handoff.
			// Re-arm under the same single-drain guard; no owner or promise chain is retained for each claim.
			if (this.claimed) this.drain();
		});
	}

	private async finishHandoff(): Promise<void> {
		try {
			for (;;) {
				this.claimed = false;
				await Promise.allSettled([...this.retiring]);
				const owner = this.owner;
				await this.persist();
				if (this.retiring.size > 0 || this.owner !== owner || this.claimed) continue;
				owner?.resume();
				return;
			}
		} catch {
			this.owner?.failed();
		}
	}

	persist(): Promise<void> {
		const run = this.saving.catch(() => undefined).then(async () => {
			// Select the latest writer and snapshot only when this serialized write starts.
			const data = JSON.parse(JSON.stringify(this.data)) as Data;
			await this.owner?.write(data);
		});
		this.saving = run;
		return run;
	}
}

// Symbol.for survives a new evaluation of the plugin bundle. The data is scoped to this App, not the module cache.
const SESSION = Symbol.for('toggl-mobile-timer.lifecycle.v1');
export function appSession(app: object, load: () => Promise<{ settings?: Partial<TogglMobileTimerSettings>; state?: unknown } | null>): Promise<TimerSession> {
	const host = app as { [SESSION]?: Promise<TimerSession> };
	if (!host[SESSION]) {
		const loading = load().then((raw) => new TimerSession(raw));
		host[SESSION] = loading;
		void loading.catch(() => { if (host[SESSION] === loading) delete host[SESSION]; });
	}
	return host[SESSION];
}
