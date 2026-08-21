import { EventApi, EventInput } from "@fullcalendar/core";
import { FerryEvent } from "../types";
import { carryOverFields } from "../types/schema";

import { DateTime, Duration } from "luxon";
import { rrulestr } from "rrule";

// The timezone convention these three encode is documented in
// `calendars/occurrences.ts`. Imported rather than restated: it is the one
// thing in the recurrence path that is wrong by a whole day when it slips.
import {
    dtstartFromWallClock,
    parseTime,
    recurrenceOf,
} from "../calendars/occurrences";
import { exclusiveEndDate, inclusiveEndDate } from "../calendars/end_date";

/*
 * Functions for converting between the types used by the fullcalendar.io view library and the
 * types used internally by Ferry Calendar.
 */

const add = (date: DateTime, time: Duration): DateTime => {
    let hours = time.hours;
    let minutes = time.minutes;
    return date.set({ hour: hours, minute: minutes });
};

const getTime = (date: Date): string =>
    DateTime.fromJSDate(date).toISOTime({
        suppressMilliseconds: true,
        includeOffset: false,
        suppressSeconds: true,
    });

const getDate = (date: Date): string => DateTime.fromJSDate(date).toISODate();

/**
 * The exclusive end FullCalendar wants, for an `endDate` off a note.
 *
 * Null rather than a throw when the value is not a date. `toEventInput` runs
 * over every event in a source on every render, so throwing here would take a
 * whole calendar off the screen because one note has `endDate: tomorrow` in it
 * — and `ParsedDate` is `z.string()`, so the schema lets that through. One bad
 * note dropping out with an error in the console is the same answer
 * `combineDateTimeStrings` gives for an unreadable time.
 */
const renderableEnd = (endDate: string): string | null => {
    try {
        return exclusiveEndDate(endDate);
    } catch (e) {
        console.error(
            `FC: Error reading endDate '${endDate}': ${
                e instanceof Error ? e.message : e
            }`
        );
        return null;
    }
};

const combineDateTimeStrings = (date: string, time: string): string | null => {
    const parsedDate = DateTime.fromISO(date);
    if (parsedDate.invalidReason) {
        console.error(
            `FC: Error parsing time string '${date}': ${parsedDate.invalidReason}`
        );
        return null;
    }

    const parsedTime = parseTime(time);
    if (!parsedTime) {
        return null;
    }

    return add(parsedDate, parsedTime).toISO({
        includeOffset: false,
        suppressMilliseconds: true,
    });
};

/**
 * The date of the occurrence the user acted on, in the terms the rule spells it.
 *
 * This is the value that becomes a `skipDate` or a `recurrenceId`, so it has to
 * name the same day the rule generated — and the direction of travel is not
 * symmetric, which is the trap:
 *
 * - **Going out**, an occurrence is a marker whose **UTC** components are the
 *   wall-clock time. That is the convention the whole recurrence path is built
 *   on; see this module's `dtstartFromWallClock` and the header of
 *   `calendars/recurrence.ts`.
 * - **Coming back**, FullCalendar hands the marker to `EventApi` through
 *   `DateEnv.toDate`, which for the default `local` timezone rebuilds those
 *   same components as a **local** date. So the wall clock that went out in UTC
 *   components arrives back in local ones.
 *
 * Which means reading it back the way it was written — with `toISODate` in UTC
 * — would be wrong by a day anywhere with an offset, in the opposite direction
 * to the mistake `dtstartFromWallClock` exists to avoid. Local components are
 * correct here precisely because UTC components were correct there.
 *
 * @param start Occurrence start, from `EventApi.start`.
 * @returns The occurrence's date, ISO `YYYY-MM-DD`.
 */
export function occurrenceDate(start: Date): string {
    return getDate(start);
}

/**
 * Build the stored shape of an event from a selection's two endpoints.
 *
 * @param start Selection start.
 * @param end Selection end, as FullCalendar gives it — **exclusive** for an
 * all-day selection, so it is pulled back a day to the inclusive `endDate` the
 * note stores. See `calendars/end_date.ts`.
 * @param allDay Whether the selection was made in an all-day row.
 */
export function dateEndpointsToFrontmatter(
    start: Date,
    end: Date,
    allDay: boolean
): Partial<FerryEvent> {
    const date = getDate(start);
    const selectedEnd = getDate(end);
    const endDate =
        allDay && selectedEnd ? inclusiveEndDate(selectedEnd) : selectedEnd;
    return {
        type: "single",
        date,
        endDate: date !== endDate ? endDate : undefined,
        allDay,
        ...(allDay
            ? {}
            : {
                  startTime: getTime(start),
                  endTime: getTime(end),
              }),
    };
}

/**
 * Translate a stored event into what FullCalendar renders.
 *
 * @param id Event ID, which the view uses to find the event again.
 * @param frontmatter The event as it is stored.
 * @param overriddenDates Occurrences of this event that an override note now
 * stands in for, from `EventCache.overriddenOccurrences`. They are cancelled
 * exactly as a `skipDate` is — the override renders as the ordinary one-date
 * event it is, and cancelling the generated occurrence is what stops the day
 * being shown twice. Ignored for an event that does not repeat.
 */
export function toEventInput(
    id: string,
    frontmatter: FerryEvent,
    overriddenDates: string[] = []
): EventInput | null {
    let event: EventInput = {
        id,
        title: frontmatter.title,
        allDay: frontmatter.allDay,
    };
    if (frontmatter.type === "recurring" || frontmatter.type === "rrule") {
        const recurrence = recurrenceOf(frontmatter);
        if (recurrence === null) {
            return null;
        }
        const dtstart = dtstartFromWallClock(
            recurrence.startDate,
            frontmatter.allDay ? null : frontmatter.startTime
        );
        if (dtstart === null) {
            return null;
        }

        // An exdate cancels an occurrence only by matching it exactly, and
        // occurrences carry their time in UTC components — so the cancelled
        // date is joined to the rule's own start time, read back the same way.
        // A date the user deleted and a date an override replaces cancel
        // identically; what differs is only whether a note took its place.
        // NOTE: this does not support events which recur more than once a day.
        const startTime = DateTime.fromJSDate(dtstart, {
            zone: "utc",
        }).toFormat("HH:mm:ss");
        const cancelled = [...recurrence.skipDates, ...overriddenDates];
        const exdate = cancelled.flatMap((d) => {
            const date = DateTime.fromISO(d).toISODate();
            return date ? [`${date}T${startTime}`] : [];
        });

        event = {
            id,
            title: frontmatter.title,
            allDay: frontmatter.allDay,
            rrule: rrulestr(recurrence.rule, { dtstart }).toString(),
            exdate,
            extendedProps: { isTask: false },
        };

        if (!frontmatter.allDay) {
            const start = parseTime(frontmatter.startTime);
            if (start && frontmatter.endTime) {
                const end = parseTime(frontmatter.endTime);
                const duration = end?.minus(start);
                if (duration) {
                    event.duration = duration.toISOTime({
                        includePrefix: false,
                        suppressMilliseconds: true,
                        suppressSeconds: true,
                    });
                }
            }
        }
    } else if (frontmatter.type === "single") {
        if (!frontmatter.allDay) {
            const start = combineDateTimeStrings(
                frontmatter.date,
                frontmatter.startTime
            );
            if (!start) {
                return null;
            }
            let end = undefined;
            if (frontmatter.endTime) {
                end = combineDateTimeStrings(
                    frontmatter.endDate || frontmatter.date,
                    frontmatter.endTime
                );
                if (!end) {
                    return null;
                }
            }

            event = {
                ...event,
                start,
                end,
                extendedProps: {
                    isTask:
                        frontmatter.completed !== undefined &&
                        frontmatter.completed !== null,
                    taskCompleted: frontmatter.completed,
                },
            };
        } else {
            let end = undefined;
            if (frontmatter.endDate) {
                // Stored inclusively, rendered exclusively.
                end = renderableEnd(frontmatter.endDate);
                if (!end) {
                    return null;
                }
            }

            event = {
                ...event,
                start: frontmatter.date,
                end,
                extendedProps: {
                    isTask:
                        frontmatter.completed !== undefined &&
                        frontmatter.completed !== null,
                    taskCompleted: frontmatter.completed,
                },
            };
        }
    }

    return event;
}

/**
 * Read an event back out of the calendar after it has been dragged or resized.
 *
 * @param event The occurrence as the view now has it.
 * @param existing The event as it is stored, when the caller has it. Required
 * to edit a recurring event: the view hands back one occurrence of a series,
 * and a rule derived from a single occurrence would be a different rule. The
 * stored one is kept and only the time of day it happens at is taken from the
 * drag, which is what dragging a recurring event has always done here.
 * @returns The event to write back.
 */
export function fromEventApi(
    event: EventApi,
    existing: FerryEvent | null = null
): FerryEvent {
    const startDate = getDate(event.start as Date);
    // FullCalendar's all-day end is exclusive; the note's is not.
    const rawEndDate = getDate(event.end as Date);
    const endDate =
        event.allDay && rawEndDate ? inclusiveEndDate(rawEndDate) : rawEndDate;
    const time = event.allDay
        ? ({ allDay: true } as const)
        : ({
              allDay: false,
              startTime: getTime(event.start as Date),
              endTime: getTime(event.end as Date),
          } as const);

    if (existing?.type === "rrule") {
        // A rule the user wrote out as an RRULE string. The view hands back one
        // occurrence, and the branch below would turn the note into that single
        // occurrence — silently destroying the rule. `shiftSeriesTo` refuses
        // hand-written rules for the same reason.
        throw new Error(
            `Cannot edit "${
                existing.title
            }" from the calendar: its repeat is written by hand as ${JSON.stringify(
                existing.rrule
            )}. Edit that rule in the note.`
        );
    }

    if (existing?.type === "recurring") {
        // The rule is kept as it stands and only the time of day comes from the
        // drag. Which *day* a series falls on is `shiftSeriesTo`'s to change,
        // and only once the user has said "All events" — this function cannot
        // know that, because it is handed one occurrence and no scope.
        return { ...existing, ...time };
    }

    return {
        // What the view cannot express, kept from the note. An override nudged
        // by five minutes must still be an override, or the master starts
        // drawing the occurrence it stands in for. See `carryOverFields`.
        ...carryOverFields(existing, "single"),
        title: event.title,
        ...time,
        type: "single",
        date: startDate,
        ...(startDate !== endDate ? { endDate } : { endDate: null }),
        completed: event.extendedProps.taskCompleted,
    };
}
