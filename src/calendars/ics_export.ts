import { DateTime } from "luxon";

import { FerryEvent } from "../types";
import { compileRecurrence } from "./recurrence";
import { exclusiveEndDate } from "./end_date";

/**
 * Export of events as an RFC 5545 iCalendar file.
 *
 * This is how notifications happen. Obsidian's mobile plugins run in a WebView
 * with no OS notification API and no background execution — see PLANNING §7.1 —
 * so the plugin cannot alert anyone itself and never will. What it can do is
 * hand the events to something that can: the file written here is subscribed to
 * by ICSx⁵ on the phone, which syncs it into the Android calendar, which owns
 * the alerts. §7.4 records that chain being measured end to end rather than
 * assumed.
 *
 * The translation is close to mechanical, because the model in PLANNING §3.2 is
 * already iCalendar's:
 *
 * | Ours | Here |
 * |---|---|
 * | `recurring:` block | `RRULE`, via `compileRecurrence` |
 * | `skipDates` | `EXDATE` |
 * | an override's `recurrenceId` | `RECURRENCE-ID`, on a VEVENT sharing the master's `UID` |
 *
 * Nothing in this module reads or writes a file, resolves a link, or knows what
 * a calendar is: it takes events that have already been paired up and returns a
 * string. It is free of Obsidian and of the DOM so it can be unit-tested
 * directly, in the same way `frontmatter.ts` and `recurrence.ts` are.
 *
 * ## What is deliberately not exported
 *
 * PLANNING §7.3 sets the envelope and it is a *security* boundary, not a
 * feature list. **Title and time only.** No note body, no file path, no vault
 * link, no `DESCRIPTION` — the body is where the private content actually
 * lives, and an exported calendar is a file that leaves the vault's protection
 * the moment it reaches a phone. Wikilinks are flattened out of titles for the
 * same reason: `[[PEOPLE/Someone]]` in a title would carry a vault path into
 * the export.
 *
 * ## Times are floating
 *
 * Events here are wall-clock local with no timezone — "06:30" means 06:30
 * wherever you are. That is exactly iCalendar's *floating* time, so `DTSTART`
 * carries neither a `Z` nor a `TZID`. The alternative, converting to UTC at
 * export, would be wrong twice over: a weekly 06:30 event would shift an hour
 * across a DST boundary, which is the same mistake `recurrence.ts` exists to
 * avoid, and it would need timezone data this plugin does not otherwise have.
 */

/** CRLF, which RFC 5545 requires between content lines. */
const CRLF = "\r\n";

/**
 * The octet limit a content line is folded at.
 *
 * Octets rather than characters: the limit is defined in bytes, and a title
 * with an em dash or an emoji in it would slip past a length check that counted
 * characters and produce a line some parsers reject.
 */
const FOLD_OCTETS = 75;

/**
 * An event to export, with the identity and parentage already worked out.
 *
 * The pairing of an override to its master is the caller's job — it means
 * following a wikilink, which is a vault operation — so what arrives here is
 * already settled.
 */
export type ExportEntry = {
    /** The event as stored. */
    event: FerryEvent;
    /**
     * Its `UID`, stable across renames.
     *
     * Not the event's cache ID, which is generated per session, and not its
     * path, which changes whenever a date or title does: either would make
     * every export look like a new set of events, and a subscriber would delete
     * and recreate the calendar rather than update it. See PLANNING §7.4.
     */
    uid: string;
    /**
     * The series this event replaces one occurrence of, if it is an override.
     *
     * An override is emitted under the **master's** UID, distinguished by
     * `RECURRENCE-ID` — that is what makes a subscriber replace the generated
     * occurrence rather than add an event beside it. The master's own event
     * comes too, because the occurrence being replaced has to be named in the
     * same terms the rule generates it in, and only the master knows those.
     */
    parent?: { uid: string; event: FerryEvent };
};

export type ExportOptions = {
    /**
     * Name offered to whatever subscribes to the file.
     *
     * A hint and nothing more: ICSx⁵ takes a display name when a subscription
     * is created and treats it as its own from then on (§7.4), so a calendar
     * renamed on the phone stays renamed. Nothing here should depend on it.
     */
    calendarName: string;
    /**
     * Minutes before an event to alert, or null for no alarm at all.
     *
     * This is the field that produces the notification, so it is the whole
     * point of the file. One value per calendar rather than per event: nothing
     * in a note says when to be reminded, and inventing a frontmatter key for
     * it before anyone has asked would be building for a requirement that does
     * not exist.
     */
    reminderMinutes: number | null;
    /** Timestamp for `DTSTAMP`. Injectable so tests are not clock-dependent. */
    now?: DateTime;
};

/**
 * Escape a value for a TEXT-typed property.
 *
 * Backslash first, or the escapes this adds would themselves be escaped.
 */
function escapeText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
}

/**
 * Flatten wikilinks out of a title.
 *
 * `[[PEOPLE/Someone|Sam]]` becomes `Sam` and `[[PEOPLE/Someone]]` becomes
 * `Someone`. PLANNING §7.3 forbids vault paths and links in exported fields,
 * and a title is the one field a user can put either in. The displayed half is
 * kept because it is what the event is called; the path is what must not
 * travel.
 */
function withoutWikilinks(title: string): string {
    return title.replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => {
        const [path, alias] = target.split("|");
        return alias ?? path.split("/").pop() ?? path;
    });
}

/**
 * Fold a content line to the octet limit.
 *
 * Continuation lines begin with a single space, which the parser strips. The
 * split has to fall on a character boundary while being measured in octets, so
 * this walks characters and counts their encoded length rather than slicing by
 * index.
 */
function fold(line: string): string {
    const encoder = new TextEncoder();
    const out: string[] = [];
    let current = "";
    let octets = 0;

    for (const char of line) {
        const size = encoder.encode(char).length;
        // Continuation lines lose one octet to the leading space.
        const limit = out.length === 0 ? FOLD_OCTETS : FOLD_OCTETS - 1;
        if (octets + size > limit) {
            out.push(current);
            current = "";
            octets = 0;
        }
        current += char;
        octets += size;
    }
    out.push(current);

    return out.join(`${CRLF} `);
}

/** `20260317T063000`, floating: no offset, no zone. */
function floatingStamp(date: string, time: string): string {
    return `${date.replace(/-/g, "")}T${time.replace(/:/g, "")}00`;
}

/** `20260317`, for a date-valued property. */
function dateStamp(date: string): string {
    return date.replace(/-/g, "");
}

/** `20260317T063000Z`, for the timestamps that genuinely are absolute. */
function utcStamp(moment: DateTime): string {
    return moment.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

/**
 * `20260318`, for the exclusive `DTEND` of an all-day event ending on the 17th.
 *
 * All-day events end *at* the start of the following day in iCalendar, while
 * ours name the last day they cover. Getting this wrong by one is the classic
 * way to make every all-day event a day longer than it is — so the shift comes
 * from `end_date.ts` rather than being written out again here.
 */
function dayAfterStamp(date: string): string {
    return dateStamp(exclusiveEndDate(date));
}

/**
 * When a timed event starts and ends, as floating stamps.
 *
 * `endTime` is optional in the model. An event without one is emitted with no
 * `DTEND` at all rather than a guessed duration: a subscriber showing a
 * zero-length event at the right time is honest, and inventing an hour would
 * put something on the calendar the user never said.
 */
function timedBounds(
    event: FerryEvent & { allDay: false },
    startDate: string,
    endDate: string
): { start: string; end: string | null } {
    return {
        start: floatingStamp(startDate, event.startTime),
        end: event.endTime ? floatingStamp(endDate, event.endTime) : null,
    };
}

/**
 * The `DTSTART`/`DTEND` lines for one event.
 *
 * @param event The event.
 * @param startDate The date it starts on — for a series this is the rule's
 * start, which is DTSTART for the whole series rather than for one occurrence.
 * @param endDate The date it ends on, inclusive, in the model's terms.
 */
function boundLines(
    event: FerryEvent,
    startDate: string,
    endDate: string
): string[] {
    if (event.allDay) {
        return [
            `DTSTART;VALUE=DATE:${dateStamp(startDate)}`,
            `DTEND;VALUE=DATE:${dayAfterStamp(endDate)}`,
        ];
    }
    const { start, end } = timedBounds(event, startDate, endDate);
    return [`DTSTART:${start}`, ...(end ? [`DTEND:${end}`] : [])];
}

/**
 * The rule line for a recurring event, or nothing for one that does not repeat.
 *
 * A hand-written `recurring.rrule` is passed through as authored;
 * `compileRecurrence` already treats it as the escape hatch it is, and
 * rewriting it here would mean this module holding a second opinion about what
 * a rule means.
 */
function ruleLines(event: FerryEvent): string[] {
    if (event.type !== "recurring") {
        return [];
    }
    const lines = [`RRULE:${compileRecurrence(event.recurring)}`];
    const skipped = event.skipDates ?? [];
    if (skipped.length === 0) {
        return lines;
    }

    // An EXDATE cancels an occurrence only by matching it exactly, so a skipped
    // date is joined to the rule's own start time — the same rule the render
    // path follows in `ui/interop.ts`, for the same reason.
    const exdates = event.allDay
        ? skipped.map(dateStamp)
        : skipped.map((date) => floatingStamp(date, event.startTime));
    const value = event.allDay ? "EXDATE;VALUE=DATE:" : "EXDATE:";
    return [...lines, `${value}${exdates.join(",")}`];
}

/**
 * The `RECURRENCE-ID` naming the occurrence an override replaces.
 *
 * Built from the **master's** shape, not the override's: it has to name the
 * occurrence in the terms the rule generates it in, and the override has by
 * then usually moved to another day and may have had its time changed. That the
 * two disagree is the normal case — see `overrideOf` in `recurrence_edit.ts`.
 */
function recurrenceIdLine(occurrence: string, master: FerryEvent): string {
    if (master.allDay) {
        return `RECURRENCE-ID;VALUE=DATE:${dateStamp(occurrence)}`;
    }
    return `RECURRENCE-ID:${floatingStamp(occurrence, master.startTime)}`;
}

/**
 * The alarm that actually produces the notification.
 *
 * `DISPLAY` rather than `AUDIO` or `EMAIL`: it is the one every calendar
 * implements, and the phone decides how to present it.
 */
function alarmLines(title: string, minutes: number | null): string[] {
    if (minutes === null || minutes <= 0) {
        return [];
    }
    return [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(title)}`,
        `TRIGGER:-PT${Math.round(minutes)}M`,
        "END:VALARM",
    ];
}

/**
 * One VEVENT.
 *
 * @throws If an override arrives without the master it replaces an occurrence
 * of. It would have to be emitted under its own UID, which would leave the
 * generated occurrence standing beside it — the day shown twice, which is the
 * failure the whole override mechanism exists to prevent.
 */
function eventLines(entry: ExportEntry, options: ExportOptions): string[] {
    const { event, uid, parent } = entry;
    const now = options.now ?? DateTime.utc();
    const title = withoutWikilinks(event.title);

    if (event.type === "rrule") {
        throw new Error(
            `Cannot export "${event.title}": it is a compiled rrule event, which only ICS and derived calendars produce and which is never stored in a note.`
        );
    }

    const isOverride = event.type === "single" && event.recurrenceId;
    if (isOverride && !parent) {
        throw new Error(
            `Cannot export "${event.title}": it replaces the occurrence on ${event.recurrenceId} of a series that could not be found, so exporting it would show that day twice.`
        );
    }

    const startDate =
        event.type === "recurring" ? event.recurring.start : event.date;
    const endDate =
        event.type === "recurring"
            ? event.recurring.start
            : event.endDate ?? event.date;

    return [
        "BEGIN:VEVENT",
        `UID:${escapeText(parent ? parent.uid : uid)}`,
        `DTSTAMP:${utcStamp(now)}`,
        ...(isOverride && parent
            ? [recurrenceIdLine(event.recurrenceId as string, parent.event)]
            : []),
        ...boundLines(event, startDate, endDate),
        ...ruleLines(event),
        `SUMMARY:${escapeText(title)}`,
        ...alarmLines(title, options.reminderMinutes),
        "END:VEVENT",
    ];
}

/**
 * Render events as an iCalendar file.
 *
 * @param entries The events to export, each with its UID and, for an override,
 * the master it belongs to.
 * @param options Calendar name and reminder lead time.
 * @returns The file's contents, CRLF-delimited and folded to 75 octets.
 */
export function exportToIcs(
    entries: ExportEntry[],
    options: ExportOptions
): string {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ferry Calendar//EN",
        "CALSCALE:GREGORIAN",
        `X-WR-CALNAME:${escapeText(options.calendarName)}`,
        ...entries.flatMap((entry) => eventLines(entry, options)),
        "END:VCALENDAR",
    ];

    return lines.map(fold).join(CRLF) + CRLF;
}
