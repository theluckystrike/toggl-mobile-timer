# Mobile Timer for Toggl Track

Mobile Timer for Toggl Track starts, stops and switches your Toggl Track timer from a note. It shows the running timer and today's total. It works on iPhone, iPad, Android and desktop, because it uses no Node module, only the request function that Obsidian gives to every plugin. It is made for the Toggl free plan, which allows 30 requests an hour.

It is not affiliated with, made by or approved by Toggl. You need your own Toggl Track account.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/mobile-timer.gif" alt="The timer panel with no timer, the Start timer window, a running timer of 27 minutes, and the timer stopped" width="720">

## Features

### Start, stop and switch a timer

Run "Start timer". A window asks for a description and offers the name of the open note. Select Start or press Enter. "Stop timer" stops it. "Switch timer" stops the running timer and starts a new one. The ribbon button starts or stops, whichever fits. "Start timer for this note" starts at once with no window, the fastest way on a phone.

The free version gives every timer one default project, which you choose in the settings.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/start-modal.png" alt="The Start timer window with the note name as the description and the default project below it" width="720">

### The timer panel and the ribbon button

A phone has no status bar, so the plugin has a timer panel. Run "Open timer panel". It shows the running timer with its clock, today's total, a Start or Stop button, a Switch button, and today's finished entries. The ribbon button turns red while a timer runs. The clock counts from the start time that Toggl holds, so it is right at once when a sleeping phone wakes up, with no request.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/timer-panel.png" alt="The timer panel with a running timer of 27 minutes, today's total and three finished entries" width="720">

### The status bar on desktop

On desktop the status bar shows the clock, the project and description, and today's total. Select it to open the panel. You can turn it off in the settings. Mobile has no status bar item.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/status-bar.png" alt="The status bar with a running timer, its description and today's total" width="720">

### Made for 30 requests an hour

One request gives the running timer and the day total: the entries of yesterday and today. "Refresh timer" also asks for the running timer itself, which is a second request. A cache younger than the refresh time (10 minutes by default) costs nothing. Start costs one request, plus one for your workspace on the first start. Stop costs one and Switch costs two. Background refreshes stop when 8 requests are left, so Start and Stop still work.

On HTTP 402 the plugin waits until the window that Toggl reports is over. On HTTP 429 it waits 2 minutes, then 4, up to 20. After a server error it waits 10 seconds, then doubles up to 5 minutes. The pill and the panel say how long, and the settings show the requests that are left.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/rate-limit.png" alt="The timer panel after Toggl answered HTTP 402, with the wait time in the pill" width="720">

### Project and tag pickers (Pro)

With Pro the Start window has a project list and a tags field. A note can set its own project: add a property named `toggl-project` with the name of a project, and "Start timer for this note" uses it.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/project-picker.png" alt="The Start timer window with a project list set to Code and a tags field" width="720">

### Reports by project or day (Pro)

Add a `toggl-report` code block to a note. `range` is today, yesterday, last7, week, month, or two dates like `2026-10-01..2026-10-31`. `by` is project, day or description. One request fills the table, and the answer is kept for 15 minutes.

~~~
```toggl-report
range: week
by: project
```
~~~

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/report.png" alt="Two report tables in a weekly report note: hours by project and hours by day" width="720">

### Edit and delete past entries (Pro)

Each finished entry in the panel has an edit button. The window changes the description, project, start and stop time, or deletes the entry after a second selection.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/edit-entry.png" alt="The Edit time entry window with description, project, start and stop" width="720">

### Offline queue (Pro)

With no connection, or after a 402, a start or stop waits in a queue of up to 40 changes and shows in the panel at once. When Toggl is reachable, the queue goes out in the fewest requests. A start followed by a stop becomes one finished entry with the real times, in one request. Without Pro, an action with no connection changes nothing.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/offline-queue.png" alt="The timer panel with a timer started offline and a line that says one change waits to be sent" width="720">

## Install

When Mobile Timer for Toggl Track is listed in the community directory, open Settings, then Community plugins, then Browse, and search for "Mobile Timer for Toggl Track". Select Install, then Enable.

To install by hand, download `main.js`, `manifest.json` and `styles.css` from the latest release. Put the three files in `<vault>/.obsidian/plugins/toggl-mobile-timer/`. Restart Obsidian or reload the list of community plugins, then turn on Mobile Timer for Toggl Track.

## Usage

Copy your API token from your Toggl Track profile settings. In the plugin settings, select the token field, create a secret and paste the token. Select Check connection. Then open a note and run "Start timer".

The token stays in the secret storage of Obsidian, not in a note or in `data.json`. The plugin does not ask for your email or password. A timer that you start in the Toggl app shows after the next refresh.

## Settings

Check connection asks Toggl who you are, 1 request. Default project and Load projects set the project of every free timer. Ask Toggl again after sets the age of the cache from 5 to 60 minutes. Week starts on sets the week of a report. Request budget shows the requests that are left this hour.

## FAQ

### Does it work on a phone?

Yes. The manifest says `isDesktopOnly: false` and the code uses no Node module. The screenshots show desktop, and the panel is the same view on a phone.

### Does the timer run when the app is closed?

The timer runs on Toggl, so yes. Obsidian cannot show a notification while it is closed, so the plugin sends no reminders.

### Which entries does the day total count?

All entries that start yesterday or today, cut at midnight of your local time. A timer that started before yesterday shows after "Refresh timer". The plugin uses your default Toggl workspace.

### Does the token sync to my other devices?

No. Obsidian keeps secrets on the device. Paste the token on each device.

## Limits

The plugin does not run in the background and does not edit projects or clients. The older plugin obsidian-toggl-integration is desktop only because it bundles a Node HTTP client. This plugin is a separate build and uses no code from it.

## Payment, account and network

The core features are free and stay free. Pro features need a GitHub Sponsors sponsorship of theluckystrike: $5 a month or more, or $15 once. When you have paid $15 in total, Pro stays on. Your notes stay readable and editable with or without Pro.

GitHub handles the payment. Sponsor at https://github.com/sponsors/theluckystrike. You need a Toggl Track account for every feature, free or Pro. Pro also needs the GitHub account that sponsors.

Mobile Timer for Toggl Track talks to Toggl Track through its public API at `https://api.track.toggl.com/api/v9`. It does this only after you save a Toggl API token in the settings. It sends the token as HTTP Basic authentication in the Authorization header of each request. It sends the time entries that you start, stop, edit or delete, which hold the description, the project, the tags, the start and stop time and the workspace number. It reads your name, your default workspace, your projects, your tags and your time entries from Toggl to show them. It sends no note content, no file names and no other vault data, and it has no telemetry. The Toggl free plan allows 30 requests an hour. The plugin counts its requests, keeps a cache, and stops sending when Toggl answers HTTP 402 or 429. Mobile Timer for Toggl Track is not affiliated with, made by or approved by Toggl. Toggl and Toggl Track are marks of their owner.

Until you select "Sign in with GitHub" in the settings, Mobile Timer for Toggl Track sends nothing to GitHub. Sign in uses the GitHub device flow. Mobile Timer for Toggl Track sends its public client ID and the scope `read:user` to `https://github.com/login/device/code` and shows you a code. While you enter the code at https://github.com/login/device, it asks `https://github.com/login/oauth/access_token` every few seconds whether sign in is done. The scope `read:user` is read-only access to your profile, which GitHub needs to show the sponsorship tier. It gives no access to repositories and no write access.

After sign in, Mobile Timer for Toggl Track sends one query to `https://api.github.com/graphql`: does the signed-in account sponsor theluckystrike, at which tier, and how much it has paid theluckystrike in total. It asks again at most once every 7 days, or when you select Refresh. It sends no note content, file names or other vault data, and it has no telemetry.

Pro keeps working for 14 days without a successful check. The GitHub token stays in the secret storage of Obsidian on this device. It is not written to data.json or other vault files, so it does not sync or reach a git repository. The local storage of this device keeps your GitHub login, the tier and the time of the last check. Sign out deletes the token. You can also revoke the access in your GitHub settings, under Applications.

## Support

Report a bug or ask for a feature in the issue tracker of this repository. To support the work, use [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

```
npm ci
npm run build
npm test
```

## License

MIT
