/**
 * The one convention that decides what `endDate` means.
 *
 * **A stored `endDate` is inclusive: it names the last day the event covers.**
 * `endDate: 2026-03-19` on a trip means the trip runs through the 19th, which
 * is what someone hand-writing that line in a note plainly intends.
 *
 * Almost nothing else agrees. FullCalendar's all-day `end` is exclusive, and so
 * is a date-valued `DTEND` in RFC 5545, and so is the `end` FullCalendar hands
 * back from a selection or a drag. Every one of those boundaries therefore
 * needs a day added or taken off, and the direction is easy to get backwards —
 * the symptom is a multi-day event drawing one day short or one day long, which
 * looks like a rendering quirk rather than a conversion bug.
 *
 * So the shift lives in two named functions rather than in five hand-written
 * `plus({ days: 1 })` calls, and every call site says which way it is going.
 *
 * **Timed events are not involved.** A timed event ends at `endTime` on
 * `endDate`, an instant with no ambiguity about whether the last day counts.
 * Only all-day events pass through here.
 */
import { DateTime } from "luxon";

/**
 * A full ISO date and nothing less.
 *
 * Checked before parsing because luxon is happy to read `2026-08` as the first
 * of August and `2026` as New Year's Day, and `endDate` is a hand-authored
 * field: `ParsedDate` in the schema is `z.string()` and validates nothing, so a
 * partial date reaches here intact. Shifting one by a day produces a date that
 * looks entirely plausible and is not what the note says.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function shift(date: string, days: number): string {
    const parsed = ISO_DATE.test(date.trim())
        ? DateTime.fromISO(date.trim(), { zone: "utc" })
        : DateTime.invalid("not a full ISO date");
    if (!parsed.isValid) {
        throw new Error(
            `Not an ISO date: ${JSON.stringify(date)}. ` +
                `An all-day end date must be YYYY-MM-DD.`
        );
    }
    return parsed.plus({ days }).toISODate();
}

/**
 * Inclusive → exclusive: the stored last day becomes the boundary after it.
 *
 * Use when handing an all-day end to something that excludes it — a
 * FullCalendar `end`, or a date-valued `DTEND`.
 *
 * @param endDate the last day covered, ISO `YYYY-MM-DD`.
 * @returns the day after it, ISO `YYYY-MM-DD`.
 * @throws if `endDate` is not a valid ISO date.
 */
export function exclusiveEndDate(endDate: string): string {
    return shift(endDate, 1);
}

/**
 * Exclusive → inclusive: a boundary becomes the last day actually covered.
 *
 * Use on any all-day end arriving from outside — a drag, a selection, an
 * imported `DTEND`.
 *
 * @param endDate the exclusive end boundary, ISO `YYYY-MM-DD`.
 * @returns the day before it, ISO `YYYY-MM-DD`.
 * @throws if `endDate` is not a valid ISO date.
 */
export function inclusiveEndDate(endDate: string): string {
    return shift(endDate, -1);
}
