import { DateTime } from "luxon";
import { rrulestr } from "rrule";
import {
    compileRecurrence,
    RecurrenceSpec,
    specFromWeekdays,
} from "./recurrence";

/**
 * Expand a compiled rule against a dtstart, the way the renderer will.
 *
 * Asserting on the RRULE string proves what was compiled; asserting on the
 * dates it generates proves it means what it is supposed to. Rules are worth
 * testing both ways, since a plausible-looking string can still expand wrong.
 *
 * DTSTART is built from UTC components and occurrences are read back as UTC,
 * per the timezone convention documented in `recurrence.ts`. Doing either in
 * the local zone makes every assertion here depend on where the test happens to
 * run — these tests were written on a machine at UTC+10, where the naive
 * version shifts a third Friday onto a Saturday.
 */
const occurrences = (
    spec: RecurrenceSpec,
    { limit = 20 }: { limit?: number } = {}
): string[] => {
    const rule = rrulestr(compileRecurrence(spec), {
        dtstart: DateTime.fromISO(spec.start, { zone: "utc" }).toJSDate(),
    });
    return rule
        .all((_, i) => i < limit)
        .map((d) => DateTime.fromJSDate(d, { zone: "utc" }).toISODate());
};

describe("compileRecurrence", () => {
    describe("the two cases the plan calls out", () => {
        it("compiles 'every week, ten times'", () => {
            expect(
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    interval: 1,
                    count: 10,
                })
            ).toBe("FREQ=WEEKLY;COUNT=10");
        });

        it("compiles 'every Tuesday and Thursday, ten times'", () => {
            expect(
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    interval: 1,
                    byDay: ["TU", "TH"],
                    count: 10,
                })
            ).toBe("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10");
        });

        it("expands the Tuesday/Thursday rule onto the right days", () => {
            // 2026-03-17 is a Tuesday.
            expect(
                occurrences({
                    start: "2026-03-17",
                    freq: "weekly",
                    byDay: ["TU", "TH"],
                    count: 6,
                })
            ).toEqual([
                "2026-03-17",
                "2026-03-19",
                "2026-03-24",
                "2026-03-26",
                "2026-03-31",
                "2026-04-02",
            ]);
        });
    });

    it.each([
        ["daily", "FREQ=DAILY"],
        ["weekly", "FREQ=WEEKLY"],
        ["monthly", "FREQ=MONTHLY"],
        ["yearly", "FREQ=YEARLY"],
    ] as const)("renders freq %p as %p", (freq, expected) => {
        expect(compileRecurrence({ start: "2026-03-17", freq })).toBe(expected);
    });

    it("omits an interval of 1, since that is the RFC default", () => {
        expect(
            compileRecurrence({
                start: "2026-03-17",
                freq: "weekly",
                interval: 1,
            })
        ).toBe("FREQ=WEEKLY");
    });

    it("emits an interval above 1", () => {
        expect(
            compileRecurrence({
                start: "2026-03-17",
                freq: "weekly",
                interval: 3,
            })
        ).toBe("FREQ=WEEKLY;INTERVAL=3");
    });

    it("expands a fortnightly rule two weeks apart", () => {
        expect(
            occurrences({
                start: "2026-03-17",
                freq: "weekly",
                interval: 2,
                count: 3,
            })
        ).toEqual(["2026-03-17", "2026-03-31", "2026-04-14"]);
    });

    describe("until", () => {
        it("is inclusive of the day it names", () => {
            const dates = occurrences({
                start: "2026-03-17",
                freq: "weekly",
                until: "2026-04-07",
            });
            // The 7th is a Tuesday and must be the last occurrence, not the
            // first one dropped.
            expect(dates).toEqual([
                "2026-03-17",
                "2026-03-24",
                "2026-03-31",
                "2026-04-07",
            ]);
        });

        it("does not admit an occurrence on the following day", () => {
            const dates = occurrences({
                start: "2026-03-17",
                freq: "daily",
                until: "2026-03-20",
            });
            expect(dates).toEqual([
                "2026-03-17",
                "2026-03-18",
                "2026-03-19",
                "2026-03-20",
            ]);
        });

        it("renders as the end of the named day in UTC", () => {
            expect(
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    until: "2026-06-30",
                })
            ).toBe("FREQ=WEEKLY;UNTIL=20260630T235959Z");
        });

        it("does not depend on the machine's timezone", () => {
            // Regression: computing the endpoint in the local zone made this
            // 20260630T140000Z at UTC+10, which drops the last occurrence of
            // any series whose DTSTART is built the way the renderer builds it.
            const compiled = compileRecurrence({
                start: "2026-03-17",
                freq: "weekly",
                until: "2026-06-30",
            });
            expect(compiled).toContain("UNTIL=20260630T235959Z");
        });
    });

    describe("the raw rrule escape hatch", () => {
        it("passes a rule through that the structured form cannot express", () => {
            expect(
                compileRecurrence({
                    start: "2026-03-17",
                    rrule: "FREQ=MONTHLY;BYDAY=3FR",
                })
            ).toBe("FREQ=MONTHLY;BYDAY=3FR");
        });

        it("expands the third-Friday rule onto third Fridays", () => {
            expect(
                occurrences(
                    { start: "2026-03-17", rrule: "FREQ=MONTHLY;BYDAY=3FR" },
                    { limit: 3 }
                )
            ).toEqual(["2026-03-20", "2026-04-17", "2026-05-15"]);
        });

        it("accepts and strips a leading RRULE: prefix", () => {
            expect(
                compileRecurrence({
                    start: "2026-03-17",
                    rrule: "RRULE:FREQ=MONTHLY;BYDAY=3FR",
                })
            ).toBe("FREQ=MONTHLY;BYDAY=3FR");
        });

        it("rejects a rule with no FREQ rather than rendering a non-repeating event", () => {
            expect(() =>
                compileRecurrence({ start: "2026-03-17", rrule: "COUNT=4" })
            ).toThrow(/no FREQ/);
        });

        it("rejects an empty rule", () => {
            expect(() =>
                compileRecurrence({ start: "2026-03-17", rrule: "   " })
            ).toThrow(/empty/);
        });

        it("rejects a rule mixed with structured fields rather than silently dropping one", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    rrule: "FREQ=MONTHLY;BYDAY=3FR",
                })
            ).toThrow(/both a raw rrule and structured freq/);
        });
    });

    describe("refusing bad rules", () => {
        it("rejects a spec with neither freq nor rrule", () => {
            expect(() => compileRecurrence({ start: "2026-03-17" })).toThrow(
                /either freq or rrule/
            );
        });

        it("rejects an unknown freq", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "fortnightly" as never,
                })
            ).toThrow(/must be one of daily, weekly, monthly, yearly/);
        });

        it("rejects count and until together", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    count: 10,
                    until: "2026-06-30",
                })
            ).toThrow(/contradict each other/);
        });

        it.each([
            ["2026-3-17", "start"],
            ["17/03/2026", "start"],
            ["not a date", "start"],
        ])("rejects %p as a start date", (start) => {
            expect(() => compileRecurrence({ start, freq: "weekly" })).toThrow(
                /recurring.start must be an ISO date/
            );
        });

        it("rejects a start date that is not a real day", () => {
            expect(() =>
                compileRecurrence({ start: "2026-02-30", freq: "weekly" })
            ).toThrow(/not a real date/);
        });

        it("rejects an until before the start", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    until: "2026-03-01",
                })
            ).toThrow(/is before recurring.start/);
        });

        it("accepts an until on the start date itself", () => {
            expect(
                occurrences({
                    start: "2026-03-17",
                    freq: "weekly",
                    until: "2026-03-17",
                })
            ).toEqual(["2026-03-17"]);
        });

        it.each([0, -1, 1.5])("rejects %p as a count", (count) => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    count,
                })
            ).toThrow(/count must be a whole number/);
        });

        it.each([0, -1, 2.5])("rejects %p as an interval", (interval) => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    interval,
                })
            ).toThrow(/interval must be a whole number/);
        });

        it("rejects an empty byDay", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    byDay: [],
                })
            ).toThrow(/non-empty list of weekdays/);
        });

        it("rejects single-letter weekday codes, which belong to the old shape", () => {
            expect(() =>
                compileRecurrence({
                    start: "2026-03-17",
                    freq: "weekly",
                    byDay: ["T", "R"] as never,
                })
            ).toThrow(/unknown weekdays/);
        });
    });
});

describe("specFromWeekdays", () => {
    it("upgrades the inherited shape to a weekly rule", () => {
        expect(specFromWeekdays(["T", "R"], "2026-03-17", undefined)).toEqual({
            start: "2026-03-17",
            freq: "weekly",
            byDay: ["TU", "TH"],
        });
    });

    it("maps endRecur onto until", () => {
        expect(specFromWeekdays(["M"], "2026-03-17", "2026-06-30")).toEqual({
            start: "2026-03-17",
            freq: "weekly",
            byDay: ["MO"],
            until: "2026-06-30",
        });
    });

    it.each([
        ["U", "SU"],
        ["M", "MO"],
        ["T", "TU"],
        ["W", "WE"],
        ["R", "TH"],
        ["F", "FR"],
        ["S", "SA"],
    ])("maps %p to %p", (legacy, expected) => {
        expect(
            specFromWeekdays([legacy], "2026-03-17", undefined).byDay
        ).toEqual([expected]);
    });

    it("omits byDay entirely when no weekdays are given", () => {
        expect(specFromWeekdays([], "2026-03-17", undefined)).toEqual({
            start: "2026-03-17",
            freq: "weekly",
        });
    });

    it("compiles to something the renderer can expand", () => {
        const spec = specFromWeekdays(["T", "R"], "2026-03-17", "2026-03-26");
        expect(compileRecurrence(spec)).toMatch(
            /^FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=/
        );
    });

    it("refuses an event with no start date", () => {
        expect(() => specFromWeekdays(["T"], undefined, undefined)).toThrow(
            /needs a start date/
        );
    });

    it("refuses an unknown weekday code", () => {
        expect(() => specFromWeekdays(["X"], "2026-03-17", undefined)).toThrow(
            /Unknown weekday code/
        );
    });
});
