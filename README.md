# Ferry Calendar

Calendar views over your Obsidian notes.

A fork of [Full Calendar](https://github.com/davish/obsidian-full-calendar) by
[Davis Haupt](https://davi.sh), extended with:

- **Real recurring events** — RFC 5545 recurrence rules, with per-instance edits and deletes
  ("this event / this and following / all events").
- **Derived calendars** — render any folder of notes on the calendar by describing how its frontmatter
  maps to events. Read-only: the source notes are never modified.
- **Calendar toggling** — show and hide calendars directly from the calendar view.

Built on [FullCalendar.io](https://fullcalendar.io/).

## Status

Early development. Not in the community plugin list.

## Installation

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add this repository as a beta plugin.

Or manually: download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](../../releases/latest) into `<vault>/.obsidian/plugins/ferry-calendar/`.

## Development

Requires Node.js 18+.

```bash
npm install
npm run dev            # esbuild watch → main.js
npm run build          # typecheck + production build
npm test               # jest
```

The repository is self-contained and has no knowledge of any vault. To test against a local vault, point
the deploy script at it:

```bash
FERRY_VAULT=/path/to/vault npm run build:deploy
```

or persist the target in `.deploy.local.json` (gitignored):

```json
{ "vault": "/path/to/vault" }
```

Install the [Hot-Reload](https://github.com/pjeby/hot-reload) plugin in your test vault to pick up
rebuilds without restarting Obsidian. Disable stock Full Calendar there first — two plugins writing the
same event notes will conflict.

## Releasing

```bash
npm version patch|minor|major     # syncs manifest.json + versions.json
git push && git push --tags
```

Tags carry no `v` prefix and must match `manifest.json` exactly; the release workflow enforces this. The
workflow builds and opens a **draft** release with `main.js`, `manifest.json`, and `styles.css` attached.
Add notes and publish.

## Licence

MIT. Original work © 2022 Davis Haupt; modifications © 2026 TheMailman123. See [LICENSE](LICENSE).
