# Mobile Timer for Toggl Track

Mobile Timer for Toggl Track starts, stops and switches your Toggl Track timer from a note. It shows the running timer and today's total. It works on iPhone, iPad, Android and desktop, because it uses no Node module. It is made for the Toggl free plan, which allows 30 requests an hour.

It is not affiliated with Toggl. You need your own Toggl Track account.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/mobile-timer.gif" alt="The timer panel with no timer, the Start timer window, a running timer of 27 minutes, and the timer stopped" width="720">

## Features

### Start, stop and switch a timer

Run "Start timer". A window asks for a description and offers the name of the open note. Select Start or press Enter. "Stop timer" stops it. "Switch timer" stops the running timer and starts a new one. The ribbon button starts or stops. "Start timer for this note" starts at once with no window, the fastest way on a phone. Both send the note name to Toggl as the description. A setting turns that off.

The free version gives every timer one default project, set in the settings.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/start-modal.png" alt="The Start timer window with the note name as the description and the default project below it" width="720">

### The timer panel and the ribbon button

Obsidian has no mobile status bar. Run "Open timer panel". It shows the clock, today's total, the Start, Stop and Switch buttons, and today's finished entries. The ribbon button turns red while a timer runs. The clock counts from the start time that Toggl holds, so it is right when a sleeping phone wakes up, with no request.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/timer-panel.png" alt="The timer panel with a running timer of 27 minutes, today's total and three finished entries" width="720">

### The status bar on desktop

On desktop the status bar shows the clock, the project and description, and today's total. Select it to open the panel. Turn it off in the settings. Mobile has none.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/status-bar.png" alt="The status bar with a running timer, its description and today's total" width="720">

### Made for 30 requests an hour

One request gives the running timer and the day total: the entries of yesterday and today. "Refresh timer" also asks for the running timer itself, which is a second request. A cache younger than the refresh time (10 minutes by default) costs nothing. Start costs one request, plus one for your workspace on the first start. Stop costs one and Switch costs two. Background refreshes stop when 8 requests are left, so Start and Stop still work.

After HTTP 402 the plugin waits until the window that Toggl reports is over. After 429 it waits 2 minutes, then 4, up to 20. After a server error it waits 10 seconds, then doubles up to 5 minutes. The panel says how long.

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

With no connection, or after a 402, a start or stop waits in a queue of up to 40 changes and shows in the panel at once. When Toggl is reachable, the queue goes out in the fewest requests. Without Pro, an action with no connection changes nothing.

<img src="https://raw.githubusercontent.com/theluckystrike/toggl-mobile-timer/HEAD/docs/offline-queue.png" alt="The timer panel with a timer started offline and a line that says one change waits to be sent" width="720">

## Install

After the community listing goes live, open Settings, Community plugins, Browse. Search for "Mobile Timer for Toggl Track". Select Install, then Enable.

Copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/toggl-mobile-timer/`. Enable the plugin.

## Usage

Copy your API token from your Toggl Track profile settings. In the plugin settings, select the token field, create a secret and paste the token. Select Check connection. Then open a note and run "Start timer".

The token stays in the secret storage of Obsidian, not in a note or in `data.json`. A timer that you start in the Toggl app shows after the next refresh.

## Settings

Check connection asks Toggl who you are, 1 request. Default project and Load projects set the project of every free timer. Use the note title as the description turns the note name off. Ask Toggl again after sets the age of the cache from 5 to 60 minutes. Week starts on sets the week of a report. Request budget shows the requests that are left this hour.

## FAQ

### Does it work on a phone?

Yes. The manifest says `isDesktopOnly: false` and the code uses no Node module. The screenshots show desktop, and the panel is the same view on a phone.

### Does the timer run when the app is closed?

The timer runs on Toggl, so yes. The plugin sends no reminders, because Obsidian cannot show one while it is closed.

### Which entries does the day total count?

All entries that start yesterday or today, cut at midnight of your local time. A timer that started before yesterday shows after "Refresh timer". The plugin uses your default Toggl workspace.

### Does the token sync to my other devices?

Obsidian's secret storage API holds the token. Plugin settings hold no token. Select or enter a token on each device.

## Limits

The plugin does not run in the background and does not edit projects or clients. It uses no code from obsidian-toggl-integration, which is desktop only.

## Payment, account and network

The core features are free. Pro features need a GitHub Sponsors sponsorship of theluckystrike: $5 a month or more, or $15 once. A total payment of $15 meets the payment requirement for Pro without further payment. Sign-in and the checks below still apply. Your notes stay readable and editable with or without Pro.

GitHub handles the payment. Sponsor at https://github.com/sponsors/theluckystrike. You need a Toggl Track account for every feature, free or Pro. Pro also needs the GitHub account that sponsors.

Mobile Timer for Toggl Track talks to Toggl Track through its public API at `https://api.track.toggl.com/api/v9`, only after you save a Toggl API token in the settings. Each request carries the token as HTTP Basic authentication in the Authorization header. When you start, stop, edit or delete a timer, it sends the time entry: the description, the project number, the tags, the start and stop time, the workspace number and the plugin name. When you start a timer from a note, the title of the note becomes the description and is sent to Toggl. That happens when you run "Start timer for this note", and when you select Start in the Start window, which opens with the title in its box. The title is the file name without the folder and the extension, cut at 120 characters. Turn off "Use the note title as the description" in the settings to send no title. It sends no note content, no folder path and no other vault data, and it has no telemetry. It reads your name, workspace, projects, tags, running timer and time entries from Toggl when Obsidian opens, when you return to the app or go online, when you open the panel or, with Pro, the Start window, when you select Refresh, Check connection or Load projects, and when a report block draws. Mobile Timer for Toggl Track is not affiliated with, made by or approved by Toggl. Toggl and Toggl Track are marks of their owner.

Until you select "Sign in with GitHub" in the settings, Mobile Timer for Toggl Track sends nothing to GitHub. Sign in uses the GitHub device flow. Mobile Timer for Toggl Track sends its public client ID and the scope `read:user` to `https://github.com/login/device/code` and shows you a code. While you enter the code at https://github.com/login/device, it asks `https://github.com/login/oauth/access_token` every few seconds to check the sign-in status. The scope permits profile reads only. GitHub needs this access to show the sponsorship tier. It grants no repository scope and no write access.

After sign in, Mobile Timer for Toggl Track sends one query to `https://api.github.com/graphql`. It checks if the signed-in account sponsors theluckystrike. It asks for the tier and the total payment to theluckystrike. The plugin reuses a successful check for 7 days. Failed checks can retry after 6 hours. Select Refresh to request an earlier check. It sends no note content, file names or other vault data to GitHub, and it has no telemetry.

After a successful check, Pro can work offline for up to 14 days. Sign out or a negative sponsorship answer turns Pro off. The plugin stores the GitHub token through the secret storage API of Obsidian. It does not put the token in its saved settings or its local sponsorship data. The local storage of this device keeps your GitHub login, the tier and the time of the last check. Sign out clears the token. You can also revoke the access in your GitHub settings, under Applications.

## Support

Report bugs and feature requests in this repository's issue tracker. To support the work, use [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

```
npm ci
npm run build
npm test
```

## License

MIT
