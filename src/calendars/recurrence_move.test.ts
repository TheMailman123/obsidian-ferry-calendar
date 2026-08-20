import { parseEvent } from "../types/schema";
import {
    occurrenceAsSingle,
    seriesFrom,
    shiftSeriesTo,
} from "./recurrence_edit";

/**
 * Moving a whole series, and the identity a derived event must not inherit —
 * PLANNING §13.2, defects 2 and 4.
 *
 * "All events" on a drag used to keep the rule wholesale and take only the time
 * of day, so the series stayed on the day it was already on and nothing said
 * so. And every event lifted out of a series carried the series' `uid`, which
 * is its durable identity in the ICS export.
 */

const weeklyOn = (byDay: string[], start = "2026-08-18") =>
    parseEvent({
        title: "yeep",
        allDay: false,
        startTime: "13:30",
        endTime: "19:30",
        recurring: { start, freq: "weekly", byDay },
        uid: "series-uid",
    });

describe("shiftSeriesTo, on a weekly rule listing its days", () => {
    it("replaces the day that was dragged", () => {
        // 2026-08-19 is a Wednesday, 2026-08-20 a Thursday.
        const moved = shiftSeriesTo(
            weeklyOn(["MO", "WE", "FR"]),
            "2026-08-19",
            "2026-08-20"
        );
        expect(moved).toMatchObject({
            recurring: { byDay: ["MO", "TH", "FR"] },
        });
    });

    it("leaves the days it was not dragged from alone", () => {
        // Translating the whole set — MO,WE,FR to TU,TH,SA — would move two
        // days the user never touched.
        const moved = shiftSeriesTo(
            weeklyOn(["MO", "WE", "FR"]),
            "2026-08-19",
            "2026-08-20"
        ) as any;
        expect(moved.recurring.byDay).not.toContain("WE");
        expect(moved.recurring.byDay).toContain("MO");
        expect(moved.recurring.byDay).toContain("FR");
    });

    it("keeps the order the days were written in", () => {
        const moved = shiftSeriesTo(
            weeklyOn(["FR", "TH", "TU", "MO"]),
            "2026-08-18", // a Tuesday
            "2026-08-19" // a Wednesday
        );
        expect(moved).toMatchObject({
            recurring: { byDay: ["FR", "TH", "WE", "MO"] },
        });
    });

    it("collapses a day dropped onto another the series already has", () => {
        // Legitimate, and it means the series now falls on one fewer day.
        const moved = shiftSeriesTo(
            weeklyOn(["TU", "WE"]),
            "2026-08-18", // Tuesday
            "2026-08-19" // Wednesday
        );
        expect(moved).toMatchObject({ recurring: { byDay: ["WE"] } });
    });

    it("moves across a week boundary", () => {
        // Sunday to Monday is +1 day and -6 weekdays. The weekday of the date
        // dropped on is the only thing that matters.
        const moved = shiftSeriesTo(
            weeklyOn(["SU"]),
            "2026-08-23", // Sunday
            "2026-08-24" // Monday
        );
        expect(moved).toMatchObject({ recurring: { byDay: ["MO"] } });
    });

    it("does not move the series start", () => {
        const moved = shiftSeriesTo(
            weeklyOn(["MO", "WE"]),
            "2026-08-19",
            "2026-08-20"
        );
        expect(moved).toMatchObject({ recurring: { start: "2026-08-18" } });
    });

    it("refuses a date the rule does not fall on", () => {
        // The caller paired the drag with the wrong series.
        expect(() =>
            shiftSeriesTo(weeklyOn(["MO"]), "2026-08-19", "2026-08-20")
        ).toThrow(/does not repeat on WE/);
    });
});

describe("shiftSeriesTo, on every other rule", () => {
    const monthly = parseEvent({
        title: "rent",
        allDay: true,
        recurring: { start: "2026-03-17", freq: "monthly" },
    });

    it("shifts the start by the days moved", () => {
        const moved = shiftSeriesTo(monthly, "2026-05-17", "2026-05-18");
        expect(moved).toMatchObject({ recurring: { start: "2026-03-18" } });
    });

    it("shifts backwards too", () => {
        const moved = shiftSeriesTo(monthly, "2026-05-17", "2026-05-14");
        expect(moved).toMatchObject({ recurring: { start: "2026-03-14" } });
    });

    it("shifts a weekly rule with no byDay", () => {
        // The weekday comes from `start`, so moving the start moves the series.
        const weekly = parseEvent({
            title: "standup",
            allDay: true,
            recurring: { start: "2026-08-18", freq: "weekly" },
        });
        expect(shiftSeriesTo(weekly, "2026-09-01", "2026-09-03")).toMatchObject(
            { recurring: { start: "2026-08-20" } }
        );
    });

    it("crosses a month boundary", () => {
        const moved = shiftSeriesTo(monthly, "2026-05-31", "2026-06-01");
        expect(moved).toMatchObject({ recurring: { start: "2026-03-18" } });
    });

    it("leaves until and count alone", () => {
        // An explicit answer to "when does this stop". Moving one occurrence is
        // not a statement about that.
        const bounded = parseEvent({
            title: "course",
            allDay: true,
            recurring: {
                start: "2026-03-17",
                freq: "monthly",
                until: "2026-09-17",
            },
        });
        expect(
            shiftSeriesTo(bounded, "2026-05-17", "2026-05-20")
        ).toMatchObject({
            recurring: { start: "2026-03-20", until: "2026-09-17" },
        });
    });
});

describe("shiftSeriesTo, what it refuses", () => {
    it("returns the series untouched when the day did not change", () => {
        const series = weeklyOn(["MO"]);
        expect(shiftSeriesTo(series, "2026-08-24", "2026-08-24")).toBe(series);
    });

    it("refuses a hand-written rule", () => {
        const custom = parseEvent({
            title: "third Friday",
            allDay: true,
            recurring: {
                start: "2026-03-20",
                rrule: "FREQ=MONTHLY;BYDAY=3FR",
            },
        });
        expect(() => shiftSeriesTo(custom, "2026-05-15", "2026-05-16")).toThrow(
            /written by hand/
        );
    });

    it("refuses an event that does not repeat", () => {
        const single = parseEvent({
            title: "x",
            allDay: true,
            date: "2026-08-18",
        });
        expect(() => shiftSeriesTo(single, "2026-08-18", "2026-08-19")).toThrow(
            /not a recurring event/
        );
    });
});

describe("the identity a derived event does not inherit", () => {
    it("does not give an override the series' uid", () => {
        // The export gives an override the master's UID *with* a
        // RECURRENCE-ID, which is what says "replaces" rather than
        // "duplicates". A uid stored on the note would outlive that pairing.
        const override = occurrenceAsSingle(weeklyOn(["TU"]), "2026-08-25");
        expect(override).not.toHaveProperty("uid");
    });

    it("does not give a split-off series the original's uid", () => {
        const next = seriesFrom(weeklyOn(["TU"]), "2026-09-01");
        expect(next).not.toHaveProperty("uid");
    });

    it("still carries everything else across", () => {
        const override = occurrenceAsSingle(weeklyOn(["TU"]), "2026-08-25");
        expect(override).toMatchObject({
            title: "yeep",
            type: "single",
            date: "2026-08-25",
            startTime: "13:30",
            endTime: "19:30",
        });
    });
});
