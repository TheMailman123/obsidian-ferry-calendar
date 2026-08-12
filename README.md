# Ferry Calendar

Calendar views over your Obsidian notes.

A fork of [Full Calendar](https://github.com/davish/obsidian-full-calendar) by
[Davis Haupt](https://davi.sh), built on [FullCalendar.io](https://fullcalendar.io/).

## Status

**Early development.** Everything upstream does, plus the two features below. Still unreleased and not
in the community plugin list.

Still to come:

- **Recurring events** — RFC 5545 recurrence rules, with per-instance edits and deletes
  ("this event / this and following / all events"). Upstream supports only a fixed set of weekdays.

## Features beyond upstream

### Calendar toggling

A key above the calendar with one row per calendar. Uncheck one to hide its events; the choice persists.

### Derived calendars

Point the plugin at any folder of notes and describe how their frontmatter becomes events. Notes that
exist for their own reasons — records that happen to carry dates — show up on the calendar without
being rewritten into events first.

**Derived calendars are read-only, structurally.** No create, no delete, no drag, no resize, and no
write path to the source notes at all. Clicking an event opens the note it came from; ctrl/cmd-click
opens it in a split. A note is a record that has dates on it, and "reschedule" is not a meaningful
thing to do to one.

Add one from Settings → *Manage Calendars* → **Custom directory (read-only)**. Before saving, the form
shows what the mapping would produce — how many notes matched, how many were skipped, and why — so a
mapping that quietly matches nothing is visible immediately rather than after the fact.

The mapping fields:

| Field | Meaning |
|---|---|
| Title | Template: `{{file.basename}}`, `{{file.path}}`, `{{property:NAME}}` |
| Start date property | Frontmatter property holding the date. May carry a time |
| End date property | Optional. The record's last day — inclusive, as written in the note |
| All-day | Always, never, or read per note from a property |
| Start/end time property | Optional, when the time is separate from the date |
| Repeat | None, yearly, monthly, or a raw RRULE. Computed at render, never written |
| Date format | `iso`, or a format like `dd/MM/yyyy` for non-ISO sources |
| Skip notes with no date | On skips them quietly; off reports them |
| Filter | Optional. Include only notes where a property is set, unset, or (not) equal to a value |

A property that is empty or `null` counts as absent either way — `DATE:` with nothing after it is not a
date. One folder can carry several mappings: add it twice with different names, and each gets its own
colour and its own row in the calendar key.

Parsing is tolerant but not silent. A value the mapping cannot read is reported with its reason rather
than dropped, both in the preview and when the calendar loads.

### Other changes

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
