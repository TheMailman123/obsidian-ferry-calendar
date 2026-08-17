import { DateTime } from "luxon";

import { FerryEvent } from "../types";

/**
 * Per-instance edits to a recurring series.
 *
 * `recurrence.ts` compiles a rule; this module *changes* one. The three
 * transformations here are the data model PLANNING §3.2 specifies, and between
 * them they are what the "this event / this and following / all events" prompt
 * chooses between:
 *
 * - **This event**, deleted — `skipOccurrence`, which appends to `skipDates`.
 *   Metadata only, no file created.
 * - **This and following** — `truncateSeriesBefore`, which caps the master with
 *   `until`. The caller then starts a new master for the edited half, so a
 *   split is two ordinary series rather than a third kind of thing to model.
 * - **This event**, edited — the caller materialises an override note instead;
 *   `overrideRecurrenceId` says which occurrence it stands in for.
 *
 * Every function here is pure and returns a new event: nothing writes, and the
 * caller decides whether the result reaches a note. The module is free of
 * Obsidian and DOM references so it can be unit-tested directly.
 *
 * ## Dates in, dates out
 *
 * Occurrence dates arrive as ISO `YYYY-MM-DD` strings and are compared as
 * strings, which is exact for that format and avoids introducing a second
 * timezone convention alongside the one in `recurrence.ts`. Reading an
 * occurrence's date *off the view* is the caller's job and has its own
 * subtlety — see `occurrenceDate` in `ui/interop.ts`.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The error for an event that was expected to repeat and does not.
 *
 * Every caller here has already decided it is acting on a series, so a
 * non-recurring event means the caller looked the wrong event up — worth
 * failing on rather than quietly returning it unchanged, which would drop the
 * user's edit on the floor.
 *
 * Returned rather than thrown so the check stays inline at each call site:
 * narrowing `type` there is what lets the new event be built from a spread,
 * which a helper doing the throwing would hide from the compiler.
 */
function notRecurring(event: FerryEvent, action: string): Error {
    return new Error(
        `Cannot ${action}: "${event.title}" is not a recurring event.`
    );
}

/** Parse an ISO date, or throw naming what was wrong with it. */
function requireIsoDate(date: string, field: string): DateTime {
    if (!ISO_DATE.test(date.trim())) {
        throw new Error(
            `${field} must be an ISO date like 2026-03-24, got ${JSON.stringify(
                date
            )}.`
        );
    }
    const parsed = DateTime.fromISO(date.trim(), { zone: "utc" });
    if (!parsed.isValid) {
        throw new Error(
            `${field} is not a real date: ${JSON.stringify(date)}.`
        );
    }
    return parsed;
}

/**
 * Cancel one occurrence of a series.
 *
 * The date joins `skipDates` on the master, which `interop.ts` already turns
 * into an exdate lined up with the occurrence it cancels. No file is created:
 * a deleted occurrence is an absence, and absences are cheaper as metadata than
 * as notes.
 *
 * Skip dates are deduplicated and sorted so that repeating the same delete is a
 * no-op on disk rather than a note that grows a line each time.
 *
 * @param master The recurring event.
 * @param date The occurrence to cancel, ISO `YYYY-MM-DD`.
 * @returns The master with the date added.
 */
export function skipOccurrence(master: FerryEvent, date: string): FerryEvent {
    if (master.type !== "recurring") {
        throw notRecurring(master, "skip an occurrence");
    }
    requireIsoDate(date, "The occurrence date");

    const skipDates = [...new Set([...(master.skipDates ?? []), date])].sort();
    return { ...master, skipDates };
}

/**
 * End a series before a given occurrence.
 *
 * `until` is inclusive, so it is set to the day *before* the occurrence: the
 * chosen occurrence is the first one that no longer happens. This is the whole
 * of "this and following" as far as the old master is concerned — for a delete
 * that is the entire operation, and for an edit the caller then creates a new
 * master starting at the same date.
 *
 * A `count` on the rule is dropped when `until` is set. The two contradict each
 * other and `compileRecurrence` refuses a rule carrying both; translating the
 * count into "however many are left" would mean expanding the rule here, and
 * `until` says the same thing without it.
 *
 * @param master The recurring event.
 * @param date The first occurrence that should no longer happen, ISO
 * `YYYY-MM-DD`.
 * @returns The capped master, or **null** if capping it would leave no
 * occurrences at all — that is, the user truncated at the first occurrence, and
 * what they have asked for is for the series to stop existing. The caller
 * deletes the master rather than writing a rule that generates nothing.
 * @throws If the rule is a hand-written `rrule:`. `compileRecurrence` takes the
 * raw string in place of the structured fields, so an `until` set beside one
 * would be silently ignored and the series would carry on — the occurrences
 * would simply not go away. Refusing says so, and leaves the user's rule alone.
 */
export function truncateSeriesBefore(
    master: FerryEvent,
    date: string
): FerryEvent | null {
    if (master.type !== "recurring") {
        throw notRecurring(master, "end a series early");
    }
    const rule = master.recurring;
    const occurrence = requireIsoDate(date, "The occurrence date");

    if (rule.rrule !== undefined) {
        throw new Error(
            `"${master.title}" repeats by a hand-written rrule, which this cannot end early without rewriting the rule you authored. Edit recurring.rrule in the note, or add an UNTIL to it by hand.`
        );
    }

    const until = occurrence.minus({ days: 1 }).toISODate();
    // ISO dates compare correctly as strings, and the alternative would be a
    // second opinion about timezones alongside the one in recurrence.ts.
    if (until === null || until < rule.start) {
        return null;
    }

    const { count: _count, ...rest } = rule;
    return { ...master, recurring: { ...rest, until } };
}

/**
 * Start a new series at a given date, carrying an edit.
 *
 * The second half of "this and following": the old master is capped by
 * `truncateSeriesBefore` and this is what takes over from the edit date. It is
 * an ordinary recurring event, which is the point — a split series is two
 * masters, not a new kind of record with a pointer between them.
 *
 * `count` is dropped for the same reason it is in `truncateSeriesBefore`: the
 * original count described the whole series, and the new master only continues
 * part of it. An `until` is carried across untouched, since the end of the
 * series has not moved.
 *
 * @param edited The event as the user has just edited it — its title, times and
 * any rule changes are what the new series takes.
 * @param date The date the new series starts, ISO `YYYY-MM-DD`.
 * @returns A recurring event starting at `date`.
 */
export function seriesFrom(edited: FerryEvent, date: string): FerryEvent {
    if (edited.type !== "recurring") {
        throw notRecurring(edited, "start a new series");
    }
    requireIsoDate(date, "The start date");

    const { count: _count, ...rest } = edited.recurring;
    return { ...edited, recurring: { ...rest, start: date } };
}
