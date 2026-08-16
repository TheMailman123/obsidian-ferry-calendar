import { Settings } from "luxon";
import { rrulestr } from "rrule";

import { parseEvent } from "../types/schema";
import { toEventInput } from "./interop";

/**
 * Rendering recurrence, and the timezone convention it is bound by.
 *
 * The `rrule` package reads the **UTC components** of DTSTART as a wall-clock
 * time and answers in the same terms, so a DTSTART built from local midnight is
 * a different day to it. These tests run in a zone well east of Greenwich,
 * where that mistake is visible: Sydney midnight is 13:00Z the day before, and
 * a series built that way comes back a day early, every occurrence of it.
 *
 * Any test here that expands a rule reads occurrences back through their UTC
 * components for the same reason.
 */

const SYDNEY = "Australia/Sydney";

beforeAll(() => {
    Settings.defaultZone = SYDNEY;
});

afterAll(() => {
    Settings.defaultZone = "system";
});

/** The DTSTART line of a rendered event, as the rrule plugin will read it. */
const dtstartOf = (rule: string): string =>
    rule.split("\n").find((line) => line.startsWith("DTSTART")) ?? "";

/** The RRULE line of a rendered event. */
const rruleOf = (rule: string): string =>
    rule.split("\n").find((line) => line.startsWith("RRULE")) ?? "";

/** Occurrences of a rendered rule, as `YYYY-MM-DDTHH:mm` in UTC components. */
const occurrences = (rule: string, count: number): string[] =>
    rrulestr(rule)
        .all((_, i) => i < count)
        .map((d) => d.toISOString().slice(0, 16));

describe("rendering a compiled rrule event", () => {
    it("builds DTSTART from the date as written, not from local midnight", () => {
        const event = toEventInput(
            "id",
            parseEvent({
                title: "Gym",
                allDay: true,
                type: "rrule",
                startDate: "2026-03-17",
                rrule: "FREQ=WEEKLY;BYDAY=TU",
                skipDates: [],
            })
        );
        expect(dtstartOf(event?.rrule as string)).toBe(
            "DTSTART:20260317T000000Z"
        );
    });

    it("builds DTSTART from the start time as written", () => {
        const event = toEventInput(
            "id",
            parseEvent({
                title: "Gym",
                allDay: false,
                startTime: "06:30",
                endTime: "07:30",
                type: "rrule",
                startDate: "2026-03-17",
                rrule: "FREQ=WEEKLY;BYDAY=TU",
                skipDates: [],
            })
        );
        expect(dtstartOf(event?.rrule as string)).toBe(
            "DTSTART:20260317T063000Z"
        );
    });

    it("lines exdates up with the occurrences they cancel", () => {
        const event = toEventInput(
            "id",
            parseEvent({
                title: "Gym",
                allDay: false,
                startTime: "06:30",
                endTime: "07:30",
                type: "rrule",
                startDate: "2026-03-17",
                rrule: "FREQ=WEEKLY;BYDAY=TU",
                skipDates: ["2026-03-24"],
            })
        );
        // An exdate that misses its occurrence by an hour cancels nothing, and
        // the deleted occurrence comes back.
        expect(event?.exdate).toEqual(["2026-03-24T06:30:00"]);
    });
});

describe("rendering an authored recurrence block", () => {
    const gym = (recurring: Record<string, unknown>) =>
        toEventInput(
            "id",
            parseEvent({
                title: "Gym",
                allDay: false,
                startTime: "06:30",
                endTime: "07:30",
                recurring,
            })
        );

    it("compiles the rule and starts it at DTSTART", () => {
        const event = gym({
            start: "2026-03-17",
            freq: "weekly",
            byDay: ["TU", "TH"],
            count: 10,
        });
        expect(dtstartOf(event?.rrule as string)).toBe(
            "DTSTART:20260317T063000Z"
        );
        expect(rruleOf(event?.rrule as string)).toBe(
            "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10"
        );
    });

    it("renders a rule the old weekday option could not express", () => {
        // Monthly, and by the third Friday: the shape that was refused
        // outright while recurrence rendered through `daysOfWeek`.
        const event = gym({
            start: "2026-03-20",
            rrule: "FREQ=MONTHLY;BYDAY=3FR",
        });
        expect(occurrences(event?.rrule as string, 3)).toEqual([
            "2026-03-20T06:30",
            "2026-04-17T06:30",
            "2026-05-15T06:30",
        ]);
    });

    it("keeps occurrences at the same clock time across a DST boundary", () => {
        // Sydney leaves daylight saving on 2026-04-05. An occurrence generated
        // from a DTSTART that carries a local offset lands an hour — and
        // sometimes a day — out on the far side of that date.
        const event = gym({
            start: "2026-03-17",
            freq: "weekly",
            byDay: ["TU"],
        });
        expect(occurrences(event?.rrule as string, 5)).toEqual([
            "2026-03-17T06:30",
            "2026-03-24T06:30",
            "2026-03-31T06:30",
            "2026-04-07T06:30",
            "2026-04-14T06:30",
        ]);
    });

    it("carries a duration so occurrences have an end", () => {
        const event = gym({
            start: "2026-03-17",
            freq: "weekly",
            byDay: ["TU"],
        });
        expect(event?.duration).toBe("01:00");
    });

    it("leaves an unusable rule off the calendar rather than guessing at it", () => {
        // `count` and `until` contradict each other. Rendering some resolution
        // of that would be wrong on every occurrence of the series.
        expect(
            gym({
                start: "2026-03-17",
                freq: "weekly",
                count: 3,
                until: "2026-06-30",
            })
        ).toBeNull();
    });
});
