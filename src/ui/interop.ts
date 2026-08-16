import { EventApi, EventInput } from "@fullcalendar/core";
import { FerryEvent } from "../types";
import {
    RecurrenceSpec,
    specFromWeekdays,
    Weekday,
} from "../calendars/recurrence";

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

const normalizeTimeString = (time: string): string | null => {
    const parsed = parseTime(time);
    if (!parsed) {
        return null;
    }
    return parsed.toISOTime({
        suppressMilliseconds: true,
        includePrefix: false,
        suppressSeconds: true,
    });
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

const DAYS = "UMTWRFS";

/** FullCalendar weekday indices, keyed by the codes an authored rule uses. */
const WEEKDAY_INDEX: Record<Weekday, number> = {
    SU: 0,
    MO: 1,
    TU: 2,
    WE: 3,
    TH: 4,
    FR: 5,
    SA: 6,
};

/**
 * The weekdays a rule falls on, as FullCalendar's `daysOfWeek` option wants
 * them, or null if the rule cannot be said that way.
 *
 * A stopgap. FullCalendar's `daysOfWeek` expresses one rule only — weekly, on a
 * set of weekdays — where the authored block can say `FREQ=MONTHLY;BYDAY=3FR`.
 * Rules it cannot carry are refused here rather than approximated, because an
 * approximated recurrence rule is not one wrong event but every occurrence of
 * it. Compiling rules through `compileRecurrence` and handing them to the rrule
 * plugin retires this entirely.
 */
function weeklyDaysOfWeek(spec: RecurrenceSpec): number[] | null {
    const expressible =
        spec.rrule === undefined &&
        spec.freq === "weekly" &&
        spec.count === undefined &&
        (spec.interval === undefined || spec.interval === 1);
    if (!expressible) {
        return null;
    }
    if (spec.byDay !== undefined) {
        return spec.byDay.map((day) => WEEKDAY_INDEX[day]);
    }
    // No BYDAY means the series repeats on DTSTART's own weekday. Luxon counts
    // Monday as 1 and Sunday as 7; FullCalendar counts Sunday as 0.
    const start = DateTime.fromISO(spec.start);
    if (!start.isValid) {
        return null;
    }
    return [start.weekday % 7];
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

export function toEventInput(
    id: string,
    frontmatter: FerryEvent
): EventInput | null {
    let event: EventInput = {
        id,
        title: frontmatter.title,
        allDay: frontmatter.allDay,
    };
    if (frontmatter.type === "recurring") {
        const daysOfWeek = weeklyDaysOfWeek(frontmatter.recurring);
        if (daysOfWeek === null) {
            console.error(
                `FC: '${frontmatter.title}' has a recurrence rule this view cannot render yet, so it has been left off the calendar.`,
                frontmatter.recurring
            );
            return null;
        }
        event = {
            ...event,
            daysOfWeek,
            startRecur: frontmatter.recurring.start,
            endRecur: frontmatter.recurring.until,
            extendedProps: { isTask: false },
        };
        if (!frontmatter.allDay) {
            event = {
                ...event,
                startTime: normalizeTimeString(frontmatter.startTime || ""),
                endTime: frontmatter.endTime
                    ? normalizeTimeString(frontmatter.endTime)
                    : undefined,
            };
        }
    } else if (frontmatter.type === "rrule") {
        const dtstart = (() => {
            if (frontmatter.allDay) {
                return DateTime.fromISO(frontmatter.startDate);
            } else {
                const dtstartStr = combineDateTimeStrings(
                    frontmatter.startDate,
                    frontmatter.startTime
                );

                if (!dtstartStr) {
                    return null;
                }
                return DateTime.fromISO(dtstartStr);
            }
        })();
        if (dtstart === null) {
            return null;
        }
        // NOTE: how exdates are handled does not support events which recur more than once per day.
        const exdate = frontmatter.skipDates
            .map((d) => {
                // Can't do date arithmetic because timezone might change for different exdates due to DST.
                // RRule only has one dtstart that doesn't know about DST/timezone changes.
                // Therefore, just concatenate the date for this exdate and the start time for the event together.
                const date = DateTime.fromISO(d).toISODate();
                const time = dtstart.toJSDate().toISOString().split("T")[1];

                return `${date}T${time}`;
            })
            .flatMap((d) => (d ? d : []));

        event = {
            id,
            title: frontmatter.title,
            allDay: frontmatter.allDay,
            rrule: rrulestr(frontmatter.rrule, {
                dtstart: dtstart.toJSDate(),
            }).toString(),
            exdate,
        };

        if (!frontmatter.allDay) {
            const startTime = parseTime(frontmatter.startTime);
            if (startTime && frontmatter.endTime) {
                const endTime = parseTime(frontmatter.endTime);
                const duration = endTime?.minus(startTime);
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

export function fromEventApi(event: EventApi): FerryEvent {
    const isRecurring: boolean = event.extendedProps.daysOfWeek !== undefined;
    const startDate = getDate(event.start as Date);
    const endDate = getDate(event.end as Date);
    return {
        title: event.title,
        ...(event.allDay
            ? { allDay: true }
            : {
                  allDay: false,
                  startTime: getTime(event.start as Date),
                  endTime: getTime(event.end as Date),
              }),

        ...(isRecurring
            ? {
                  type: "recurring",
                  recurring: specFromWeekdays(
                      event.extendedProps.daysOfWeek.map(
                          (i: number) => DAYS[i]
                      ),
                      event.extendedProps.startRecur &&
                          getDate(event.extendedProps.startRecur),
                      event.extendedProps.endRecur &&
                          getDate(event.extendedProps.endRecur)
                  ),
              }
            : {
                  type: "single",
                  date: startDate,
                  ...(startDate !== endDate ? { endDate } : { endDate: null }),
                  completed: event.extendedProps.taskCompleted,
              }),
    };
}
