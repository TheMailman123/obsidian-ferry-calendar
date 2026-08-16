import { FerryEvent } from "../types";

/**
 * Filename construction for working-calendar event notes.
 *
 * Working-calendar notes are named `<date>_TITLE_SLUG.md`, where the date part
 * is rendered in the user's configured format and defaults to `yyyymmdd`. The
 * prefix exists so notes sort chronologically in the file explorer and read
 * clearly in search results and backlinks; it is *not* where the plugin reads
 * dates from.
 *
 * The governing rule for everything in this module:
 *
 * > Frontmatter is authoritative. The filename is derived from it, and the
 * > plugin maintains it.
 *
 * Which means slugging is deliberately **one-way**. Nothing here parses a
 * filename back into a title or a date, and nothing should be added that does:
 * the slug is lossy by design (commas, apostrophes and spaces do not survive
 * it), so a filename is never evidence about an event.
 *
 * This module is free of Obsidian and DOM references so it can be unit-tested
 * directly.
 */

/**
 * Subdirectory of a working calendar holding recurring masters.
 *
 * The leading underscore sorts it above the dated notes in the file explorer.
 *
 * Nothing parses masters yet — that arrives with the recurrence engine — and
 * nothing here needs to name the directory, because a working calendar only
 * ever reads its immediate children and so skips every subfolder alike. The
 * constant exists so the convention has one spelling, and is pinned by the
 * calendar-membership test that asserts a master stays unparsed.
 */
export const RECURRING_DIR = "_recurring";

/**
 * Characters that may not appear in a filename.
 *
 * Two groups, for two different reasons:
 *
 * - `\ / : * ? " < > |` and the C0 control characters are illegal in Windows
 *   filenames. The vault may well be synced to a Windows machine even when it
 *   was authored elsewhere, so this is not optional.
 * - `# ^ [ ] |` are reserved by Obsidian for link syntax. A filename containing
 *   them cannot be linked to cleanly.
 *
 * Commas and apostrophes are stripped alongside them. They are legal
 * everywhere, but they read badly in an underscore-separated filename and are a
 * common source of shell quoting pain. They survive in the frontmatter `title`,
 * which is the only place a title is actually stored.
 */
const ILLEGAL_CHARACTERS = /[\\/:*?"<>|#^[\]',\x00-\x1f]/g;

/**
 * Turn a prose title into the slug portion of a filename.
 *
 * Case is preserved rather than normalised: uppercasing is lossy and the plugin
 * has no business having an opinion about how a user capitalises their titles.
 *
 * @param title Prose title, from frontmatter.
 * @returns A slug safe to use as a filename component. Never empty — a title
 * that slugs away to nothing yields `untitled`, since a file still needs a name.
 */
export function slugifyTitle(title: string): string {
    const slug = title
        // Whitespace becomes underscores before anything is stripped: tabs and
        // newlines are control characters too, and a title with a tab in it
        // should read as a word break rather than losing the gap entirely.
        .replace(/\s+/g, "_")
        .replace(ILLEGAL_CHARACTERS, "")
        .replace(/_+/g, "_")
        // Leading and trailing dots are stripped along with underscores:
        // a leading dot hides the file on unix, and Windows rejects a
        // trailing one.
        .replace(/^[_.]+|[_.]+$/g, "");
    return slug.length > 0 ? slug : "untitled";
}

/**
 * How the date part of an event filename is rendered.
 *
 * A closed set rather than a free-form format string, deliberately. An
 * arbitrary format could emit path separators or characters Obsidian reserves
 * for link syntax, and would have to be validated back out of user input on
 * every keystroke; the handful of layouts anyone actually wants are all here.
 *
 * The first three sort chronologically in the file explorer, which is the
 * reason the prefix exists at all. The day-first and month-first forms do not —
 * they are offered because it is the user's vault, but the settings copy says
 * plainly what is being given up.
 */
export const FILENAME_DATE_FORMATS = [
    "yyyymmdd",
    "yyyy-mm-dd",
    "yyyy_mm_dd",
    "ddmmyyyy",
    "mmddyyyy",
] as const;

export type FilenameDateFormat = (typeof FILENAME_DATE_FORMATS)[number];

/**
 * Format used when the user has never chosen one.
 *
 * Matches the `TRIPS` convention the vault already uses, and sorts.
 */
export const DEFAULT_FILENAME_DATE_FORMAT: FilenameDateFormat = "yyyymmdd";

/**
 * Human-readable label for each format, for the settings dropdown.
 *
 * Kept beside the formats themselves so adding one cannot leave the UI showing
 * a raw enum value.
 */
export const FILENAME_DATE_FORMAT_LABELS: Record<FilenameDateFormat, string> = {
    yyyymmdd: "20251121 — compact, sorts by date",
    "yyyy-mm-dd": "2025-11-21 — ISO, sorts by date",
    yyyy_mm_dd: "2025_11_21 — underscores, sorts by date",
    ddmmyyyy: "21112025 — day first, does not sort by date",
    mmddyyyy: "11212025 — month first, does not sort by date",
};

/**
 * Whether a value is one of the known filename date formats.
 *
 * Settings are loaded from a JSON file the user can edit by hand, so the stored
 * value is not to be trusted just because it is typed as one.
 */
export function isFilenameDateFormat(
    value: unknown
): value is FilenameDateFormat {
    return FILENAME_DATE_FORMATS.includes(value as FilenameDateFormat);
}

/**
 * Render an ISO date as the filename prefix, in the given format.
 *
 * @param date Date string from frontmatter, expected as `YYYY-MM-DD`.
 * @param format Layout to render in. Defaults to `yyyymmdd`.
 * @returns The prefix, or null if the string is not an ISO date. Callers decide
 * what an unusable date means: creating an event fails on it, while the repair
 * planner records it as a note it cannot plan a name for and reports it.
 */
export function datePrefix(
    date: string,
    format: FilenameDateFormat = DEFAULT_FILENAME_DATE_FORMAT
): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!match) {
        return null;
    }
    const [, yyyy, mm, dd] = match;
    switch (format) {
        case "yyyymmdd":
            return `${yyyy}${mm}${dd}`;
        case "yyyy-mm-dd":
            return `${yyyy}-${mm}-${dd}`;
        case "yyyy_mm_dd":
            return `${yyyy}_${mm}_${dd}`;
        case "ddmmyyyy":
            return `${dd}${mm}${yyyy}`;
        case "mmddyyyy":
            return `${mm}${dd}${yyyy}`;
    }
}

/**
 * The date a given event's filename should be prefixed with.
 *
 * For a single event that is the event's date. For a recurring event it is
 * DTSTART — the master is named for when the series begins, so masters sort
 * among themselves.
 */
function startDateForEvent(event: FerryEvent): string {
    switch (event.type) {
        case undefined:
        case "single":
            return event.date;
        case "recurring":
            return event.recurring.start;
        case "rrule":
            return event.startDate;
    }
}

/**
 * The filename an event should have, without the `.md` extension and before
 * collision handling.
 *
 * Every event has a start date to be named for, recurring ones included: the
 * authored `recurring` block requires DTSTART, since a series with no beginning
 * has no occurrences to generate.
 *
 * @param event Event to name.
 * @param format Date format to render the prefix in.
 * @returns `<date>_TITLE_SLUG`.
 * @throws If the event has a start date that is not an ISO date. A note filed
 * under a date the plugin could not read would be a note filed under the wrong
 * date, which is worse than failing here.
 */
export function basenameForEvent(
    event: FerryEvent,
    format: FilenameDateFormat = DEFAULT_FILENAME_DATE_FORMAT
): string {
    const slug = slugifyTitle(event.title);
    const start = startDateForEvent(event);
    const prefix = datePrefix(start, format);
    if (prefix === null) {
        throw new Error(
            `Event "${event.title}" has an unusable date ${JSON.stringify(
                start
            )}: expected YYYY-MM-DD.`
        );
    }
    return `${prefix}_${slug}`;
}

/**
 * The folder inside a working calendar where an event's note belongs.
 *
 * Recurrence masters live in `_recurring/` and everything else sits directly in
 * the calendar's own folder. Keeping the masters apart is what stops a rule
 * being read as an ordinary event on the day its DTSTART falls, and the leading
 * underscore sorts them above the dated notes in the file explorer.
 *
 * @param directory The calendar's folder.
 * @param event Event to place.
 */
export function folderForEvent(directory: string, event: FerryEvent): string {
    return event.type === "recurring"
        ? `${directory}/${RECURRING_DIR}`
        : directory;
}

/**
 * The full filename an event should have, before collision handling.
 */
export function filenameForEvent(
    event: FerryEvent,
    format: FilenameDateFormat = DEFAULT_FILENAME_DATE_FORMAT
): string {
    return `${basenameForEvent(event, format)}.md`;
}

/** Upper bound on collision suffixes, so a broken `isTaken` cannot hang. */
const MAX_COLLISION_SUFFIX = 1000;

/**
 * Append `_2`, `_3`, ... until the basename is free.
 *
 * Two events on the same day with the same title are perfectly legitimate and
 * must both be storable, so a collision picks a fresh name rather than
 * refusing. Suffixes are assigned in creation order, which makes the result
 * deterministic for a given sequence of creations.
 *
 * @param basename Desired basename, from `basenameForEvent`.
 * @param isTaken Predicate reporting whether a basename is already in use. The
 * caller supplies this so that "in use" can exclude the file being renamed.
 * @returns The first free basename.
 * @throws If a thousand consecutive candidates are all taken, which means
 * `isTaken` is wrong rather than that the vault has a thousand identical events.
 */
export function disambiguate(
    basename: string,
    isTaken: (candidate: string) => boolean
): string {
    if (!isTaken(basename)) {
        return basename;
    }
    for (let n = 2; n <= MAX_COLLISION_SUFFIX; n++) {
        const candidate = `${basename}_${n}`;
        if (!isTaken(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        `Could not find a free filename for "${basename}" after ${MAX_COLLISION_SUFFIX} attempts.`
    );
}

/**
 * Whether an existing basename is one the plugin would have produced.
 *
 * Not simple equality, because a collision suffix is part of a *correct* name:
 * `20251121_Gym_2` is what the plugin itself assigned to the second event that
 * day, and must not be read as drift. Without this the repair pass would fight
 * its own collision handling, renaming `_2` back to the unsuffixed name on
 * every load.
 *
 * @param actual Basename the file currently has.
 * @param expected Basename derived from the event's frontmatter.
 */
export function basenameMatchesEvent(
    actual: string,
    expected: string
): boolean {
    if (actual === expected) {
        return true;
    }
    if (!actual.startsWith(`${expected}_`)) {
        return false;
    }
    const suffix = actual.slice(expected.length + 1);
    return /^\d+$/.test(suffix);
}
