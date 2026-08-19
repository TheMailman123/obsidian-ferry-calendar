import { DateTime, Duration } from "luxon";
import { rrulestr } from "rrule";

import { FerryEvent } from "../types";
import { compileRecurrence } from "./recurrence";

/**
 * Turning stored events into the concrete times they actually happen at.
 *
 * The calendar view never needs this: it hands rules to FullCalendar's rrule
 * plugin and lets the library expand them across whatever is on screen. But an
 * upcoming list and a reminder both have to answer "what happens next", which
 * is a flat list of occurrences, and nothing in the plugin produced one.
 *
 * The negative requirement from PLANNING §8 is what shapes this module: the
 * cache holds **one event per master, never expanded occurrences**. So nothing
 * here is stored or cached. A window goes in, the occurrences inside it come
 * out, and "every Tuesday, forever" costs whatever the window costs.
 *
 * ## The timezone convention lives here
 *
 * The `rrule` package reads the **UTC components** of DTSTART as a wall-clock
 * time and answers in the same terms. So a rule is fed a DTSTART assembled in
 * UTC from the date and time as written, and every occurrence it returns has to
 * be read back the same way and only then placed in the real zone.
 *
 * `ui/interop.ts` used to hold these three helpers privately, and it now
 * imports them from here. That matters more than it looks: this convention is
 * the single thing in the recurrence path that is wrong by a whole day when it
 * slips, and two copies of it would be two things to keep in step.
 */

/** A rule to expand, however the event happened to express it. */
export interface Recurrence {
    /** RRULE string, without DTSTART. */
    rule: string;
    /** The day the series begins. */
    startDate: string;
    /** Dates whose occurrence is cancelled. */
    skipDates: string[];
}

/** One concrete instance of an event, at a real point in time. */
export type Occurrence = {
    /** Cache ID of the event this came from — a master, for a series. */
    id: string;
    /** Calendar the event belongs to. */
    calendarId: string;
    /** The event as stored. A series contributes many occurrences, one event. */
    event: FerryEvent;
    /** When this instance starts, in the local zone. */
    start: DateTime;
    /** When it ends, or null if it says only when it begins. */
    end: DateTime | null;
    /** Whether it occupies whole days rather than a time of day. */
    allDay: boolean;
};

/** An event as the cache holds it, with the identity needed to act on it. */
export type StoredEntry = {
    id: string;
    calendarId: string;
    event: FerryEvent;
};

/**
 * Read a time of day out of frontmatter.
 *
 * Three formats are accepted because all three have been written by hand in
 * real notes: `9:00 AM`, `09:00`, and `09:00:00`.
 *
 * @param time The value as written.
 * @returns The time as a duration since midnight, or null if unreadable — the
 * event then does not appear at all, rather than appearing at midnight.
 */
export function parseTime(time: string): Duration | null {
    let parsed = DateTime.fromFormat(time, "h:mm a");
    if (parsed.invalidReason) {
        parsed = DateTime.fromFormat(time, "HH:mm");
    }
    if (parsed.invalidReason) {
        parsed = DateTime.fromFormat(time, "HH:mm:ss");
    }

    if (parsed.invalidReason) {
        console.error(
            `FC: Error parsing time string '${time}': ${parsed.invalidReason}'`
        );
        return null;
    }

    return Duration.fromISOTime(
        parsed.toISOTime({
            includeOffset: false,
            includePrefix: false,
        })
    );
}

/**
 * DTSTART for a recurrence rule, in the terms the `rrule` package reads.
 *
 * That package takes the **UTC components** of DTSTART as a wall-clock time and
 * answers in the same terms, so the date and time as the user wrote them are
 * assembled in UTC and handed over unconverted. Building this from the local
 * zone instead is the mistake the whole recurrence path has to avoid: Sydney
 * midnight is 13:00Z the day before, and every occurrence of the series then
 * comes back a day early.
 *
 * @param date Start date, ISO `YYYY-MM-DD`.
 * @param time Start time, or null for an all-day event.
 * @returns The date, or null if either half was unreadable — in which case the
 * event does not render at all, rather than rendering on the wrong day.
 */
export function dtstartFromWallClock(
    date: string,
    time: string | null
): Date | null {
    const day = DateTime.fromISO(date, { zone: "utc" });
    if (!day.isValid) {
        console.error(
            `FC: Error parsing start date '${date}': ${day.invalidReason}`
        );
        return null;
    }
    if (time === null) {
        return day.toJSDate();
    }
    const parsed = parseTime(time);
    if (!parsed) {
        return null;
    }
    return day.plus(parsed).toJSDate();
}

/**
 * The rule an event repeats by.
 *
 * Both recurring shapes converge here: `recurring` is the block as authored in
 * a note, compiled on the way past, and `rrule` is the already-compiled form
 * that ICS and derived calendars build internally. Compiling at the render
 * boundary rather than on read is what keeps the authored block in the file —
 * a note read and written back would otherwise have its rule replaced by an
 * opaque `FREQ=WEEKLY;BYDAY=TU,TH`.
 *
 * @returns The rule, or null if the event does not repeat, or if the authored
 * block does not describe a rule. `compileRecurrence` refuses rules it cannot
 * read rather than resolving them, since a wrong rule is not one wrong event
 * but every occurrence of it.
 */
export function recurrenceOf(frontmatter: FerryEvent): Recurrence | null {
    if (frontmatter.type === "rrule") {
        return {
            rule: frontmatter.rrule,
            startDate: frontmatter.startDate,
            skipDates: frontmatter.skipDates,
        };
    }
    if (frontmatter.type === "recurring") {
        try {
            return {
                rule: compileRecurrence(frontmatter.recurring),
                startDate: frontmatter.recurring.start,
                skipDates: frontmatter.skipDates ?? [],
            };
        } catch (e) {
            console.error(
                `FC: '${
                    frontmatter.title
                }' has a recurrence rule that cannot be compiled, so it has been left off the calendar: ${
                    e instanceof Error ? e.message : String(e)
                }`
            );
            return null;
        }
    }
    return null;
}

/**
 * How long an event lasts, from the times it was written with.
 *
 * @returns The duration, or null for an event that says only when it starts.
 */
function durationOf(event: FerryEvent): Duration | null {
    if (event.allDay || !event.endTime) {
        return null;
    }
    const start = parseTime(event.startTime);
    const end = parseTime(event.endTime);
    if (!start || !end) {
        return null;
    }
    const duration = end.minus(start);
    return duration.valueOf() > 0 ? duration : null;
}

/**
 * When a timed single event finishes.
 *
 * Read from `endDate` where there is one rather than from the length of the
 * day it starts on, because a single event is allowed to run past midnight —
 * a ferry leaving at 22:00 and arriving at 06:00 is one event, not two, and
 * subtracting its times gives eight hours *backwards*. `ui/interop.ts` reads
 * the pair the same way, which is what makes an occurrence agree with what the
 * calendar draws.
 *
 * A series cannot do this: `endDate` names one day, and a rule generates many,
 * so a repeating event's length comes from `durationOf` instead.
 *
 * @returns The end, or null for an event that says only when it starts, or
 * whose end is not after its start and so cannot be believed.
 */
function timedEnd(event: FerryEvent, start: DateTime): DateTime | null {
    if (event.allDay || event.type !== "single" || !event.endTime) {
        return null;
    }
    const time = parseTime(event.endTime);
    const day = DateTime.fromISO(event.endDate ?? event.date);
    if (!time || !day.isValid) {
        return null;
    }
    const end = day.plus(time);
    return end > start ? end : null;
}

/**
 * A wall-clock reading of a moment, for handing to or taking from `rrule`.
 *
 * The components are preserved and the zone is relabelled, never converted —
 * that is the whole convention in one line, in both directions.
 */
const asWallClock = (moment: DateTime): DateTime =>
    moment.setZone("utc", { keepLocalTime: true });
const fromWallClock = (moment: DateTime): DateTime =>
    moment.setZone("system", { keepLocalTime: true });

/**
 * The occurrences a single non-repeating event contributes.
 *
 * At most one, and only if it lands in the window. Its start is a real local
 * instant, with none of the UTC-components business the rules need: a date in
 * frontmatter means that day where the user is.
 */
function singleOccurrences(
    entry: StoredEntry,
    from: DateTime,
    to: DateTime
): Occurrence[] {
    const { event } = entry;
    if (event.type !== "single") {
        return [];
    }

    let start: DateTime;
    let end: DateTime | null;
    if (event.allDay) {
        start = DateTime.fromISO(event.date);
        end = event.endDate
            ? DateTime.fromISO(event.endDate).endOf("day")
            : null;
    } else {
        const time = parseTime(event.startTime);
        const day = DateTime.fromISO(event.date);
        if (!time || !day.isValid) {
            return [];
        }
        start = day.plus(time);
        end = timedEnd(event, start);
    }
    if (!start.isValid) {
        return [];
    }

    // Compared against the end where there is one, so a multi-day trip already
    // under way is still "on" rather than already past.
    const finish = end ?? start;
    if (finish < from || start > to) {
        return [];
    }
    return [
        {
            id: entry.id,
            calendarId: entry.calendarId,
            event,
            start,
            end,
            allDay: event.allDay,
        },
    ];
}

/**
 * The occurrences a series contributes inside the window.
 *
 * @param cancelledDates Dates this master does not occur on: its own
 * `skipDates`, plus the occurrences that override notes stand in for. Both
 * cancel identically — what differs is only whether a note took the place of
 * the one that went.
 */
function recurringOccurrences(
    entry: StoredEntry,
    from: DateTime,
    to: DateTime,
    cancelledDates: string[]
): Occurrence[] {
    const { event } = entry;
    const recurrence = recurrenceOf(event);
    if (!recurrence) {
        return [];
    }
    const dtstart = dtstartFromWallClock(
        recurrence.startDate,
        event.allDay ? null : event.startTime
    );
    if (dtstart === null) {
        return [];
    }

    const cancelled = new Set([...recurrence.skipDates, ...cancelledDates]);
    const duration = durationOf(event);

    // The window is handed over in the same wall-clock terms the rule answers
    // in, or the first and last day of the range would be off by the offset.
    let expanded: Date[];
    try {
        expanded = rrulestr(recurrence.rule, { dtstart }).between(
            asWallClock(from).toJSDate(),
            asWallClock(to).toJSDate(),
            true
        );
    } catch (e) {
        // A `recurring` block was compiled and checked on the way in, but an
        // `rrule` is a raw string — hand-written, or parsed out of a remote
        // calendar — and `rrulestr` throws on one it cannot read. Thrown from
        // here it would take every other event's occurrences with it, and this
        // is called from a timer where nothing is waiting to catch it.
        console.error(
            `FC: '${
                event.title
            }' has a recurrence rule that cannot be read, so it has been left out: ${
                e instanceof Error ? e.message : String(e)
            }`
        );
        return [];
    }

    return expanded.flatMap((occurrence) => {
        const wall = DateTime.fromJSDate(occurrence, { zone: "utc" });
        const date = wall.toISODate();
        if (!date || cancelled.has(date)) {
            return [];
        }
        const start = fromWallClock(wall);
        return [
            {
                id: entry.id,
                calendarId: entry.calendarId,
                event,
                start,
                end: duration ? start.plus(duration) : null,
                allDay: event.allDay,
            },
        ];
    });
}

/**
 * Every occurrence falling inside a window, in the order they happen.
 *
 * Nothing is stored: this expands, answers, and forgets. Callers hold the
 * window, so the cost is theirs to choose — see PLANNING §8.
 *
 * @param entries The events as the cache holds them, one per master.
 * @param from Start of the window, inclusive.
 * @param to End of the window, inclusive.
 * @param cancelled Occurrences replaced by override notes, keyed by master
 * event ID, as `EventCache.overriddenOccurrences` returns them. Omitted, a
 * series shows the occurrences its overrides were meant to replace as well as
 * the overrides themselves — the double-booking §3.2 exists to prevent.
 * @returns Occurrences sorted by start time. An event that cannot be read —
 * an unparseable time, a rule that will not compile — contributes none, having
 * already said so on the console.
 */
export function occurrencesInWindow(
    entries: StoredEntry[],
    from: DateTime,
    to: DateTime,
    cancelled: Map<string, string[]> = new Map()
): Occurrence[] {
    const found = entries.flatMap((entry) =>
        entry.event.type === "single"
            ? singleOccurrences(entry, from, to)
            : recurringOccurrences(
                  entry,
                  from,
                  to,
                  cancelled.get(entry.id) ?? []
              )
    );
    return found.sort((a, b) => a.start.toMillis() - b.start.toMillis());
}
