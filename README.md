# Ferry Calendar

Calendar views over your Obsidian notes.

A fork of [Full Calendar](https://github.com/davish/obsidian-full-calendar) by
[Davis Haupt](https://davi.sh), built on [FullCalendar.io](https://fullcalendar.io/).

## Status

**Early development, and currently at feature parity with upstream.** So far this fork differs only in
its build toolchain and a bug fix; if you want a working calendar plugin today, install Full Calendar
instead. There is nothing here yet that it does not already do.

The fork exists to build the following, none of which is implemented:

- **Recurring events** — RFC 5545 recurrence rules, with per-instance edits and deletes
  ("this event / this and following / all events"). Upstream supports only a fixed set of weekdays.
- **Derived calendars** — render any folder of notes on the calendar by describing how its frontmatter
  maps to events, read-only, so the source notes are never modified.
- **Calendar toggling** — show and hide calendars from the calendar view.

This list will move up into a features section as each part lands. Not in the community plugin list.

### Changes so far

- Modernised toolchain: TypeScript 5.9, esbuild 0.28, Obsidian 1.x API types.
- Fixed an event on line 0 of a file losing its line number.
- Fixed two null-dereferences that the older, looser Obsidian typings hid.
- Renamed the inherited `OFC*` types and `FullCalendar*` classes to `Ferry*`, and the `.ofc-` CSS
  classes to `.ferry-`. If you styled this plugin with a CSS snippet, update those selectors.

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

To deploy to several vaults at once, use `vaults` instead. Every path is validated before anything is
copied, so a typo cannot leave one vault updated and another stale:

```json
{ "vaults": ["/path/to/vault-one", "/path/to/vault-two"] }
```

Install the [Hot-Reload](https://github.com/pjeby/hot-reload) plugin in your test vault to pick up
rebuilds without restarting Obsidian. Disable stock Full Calendar there first — two plugins writing the
same event notes will conflict.

## Releasing

```bash
npm version patch|minor|major     # syncs manifest.json + versions.json, creates the tag
git push
git push origin "$(node -p 'require("./manifest.json").version')"
```

Tags carry no `v` prefix and must match `manifest.json` exactly; the release workflow enforces this. The
workflow builds and opens a **draft** release with `main.js`, `manifest.json`, and `styles.css` attached.
Add notes and publish.

## Licence

MIT. Original work © 2022 Davis Haupt; modifications © 2026 TheMailman123. See [LICENSE](LICENSE).
