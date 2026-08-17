import { EventApi, EventInput } from "@fullcalendar/core";
import { FerryEvent } from "../types";
import { compileRecurrence } from "../calendars/recurrence";

import { DateTime, Duration } from "luxon";
import { rrulestr } from "rrule";

/*
 * Functions for converting between the types used by the fullcalendar.io view library and the
 * types used internally by Ferry Calendar.
 */

const parseTime = (time: string): Duration | null => {
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
};

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
 * DTSTART for a recurrence rule, in the terms the `rrule` package reads.
 *
 * That package takes the **UTC components** of DTSTART as a wall-clock time and
 * answers in the same terms, so the date and time as the user wrote them are
 * assembled in UTC and handed over unconverted. Building this from the local
 * zone instead is the mistake the whole module has to avoid: Sydney midnight is
 * 13:00Z the day before, and every occurrence of the series then comes back a
 * day early.
 *
 * @param date Start date, ISO `YYYY-MM-DD`.
 * @param time Start time, or null for an all-day event.
 * @returns The date, or null if either half was unreadable — in which case the
 * event does not render at all, rather than rendering on the wrong day.
 */
function dtstartFromWallClock(date: string, time: string | null): Date | null {
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

/** A rule to expand, however the event happened to express it. */
interface Recurrence {
    /** RRULE string, without DTSTART. */
    rule: string;
    /** The day the series begins. */
    startDate: string;
    /** Dates whose occurrence is cancelled. */
    skipDates: string[];
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
 * @returns The rule, or null if the authored block does not describe one.
 * `compileRecurrence` refuses rules it cannot read rather than resolving them,
 * since a wrong rule is not one wrong event but every occurrence of it.
 */
function recurrenceOf(frontmatter: FerryEvent): Recurrence | null {
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

export function dateEndpointsToFrontmatter(
    start: Date,
    end: Date,
    allDay: boolean
): Partial<FerryEvent> {
    const date = getDate(start);
    const endDate = getDate(end);
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
            event = {
                ...event,
                start: frontmatter.date,
                end: frontmatter.endDate || undefined,
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
    const endDate = getDate(event.end as Date);
    const time = event.allDay
        ? ({ allDay: true } as const)
        : ({
              allDay: false,
              startTime: getTime(event.start as Date),
              endTime: getTime(event.end as Date),
          } as const);

    if (existing?.type === "recurring") {
        // Moving an occurrence to another day is a per-instance edit, which
        // needs the "this event / this and following / all events" prompt to
        // mean anything, so for now the series keeps its rule and the day is
        // left where the rule puts it.
        return { ...existing, ...time };
    }

    return {
        title: event.title,
        ...time,
        type: "single",
        date: startDate,
        ...(startDate !== endDate ? { endDate } : { endDate: null }),
        completed: event.extendedProps.taskCompleted,
    };
}
