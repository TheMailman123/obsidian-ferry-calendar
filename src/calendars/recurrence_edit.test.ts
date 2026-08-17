import { isOverride, parseEvent } from "../types/schema";
import {
    overrideOf,
    seriesFrom,
    skipOccurrence,
    truncateSeriesBefore,
} from "./recurrence_edit";

/**
 * Per-instance edits to a series.
 *
 * Nothing here expands a rule, so nothing here needs a pinned timezone — the
 * transformations work in ISO date strings throughout, which is the point of
 * doing them this way. The zone-sensitive half of the story is the *reading* of
 * an occurrence date off the view, which `ui/interop.test.ts` pins.
 */

const gym = (
    recurring: Record<string, unknown>,
    extra: Record<string, unknown> = {}
) =>
    parseEvent({
        title: "Gym",
        allDay: false,
        startTime: "06:30",
        endTime: "07:30",
        recurring,
        ...extra,
    });

const weekly = { start: "2026-03-17", freq: "weekly", byDay: ["TU"] };

describe("skipping one occurrence", () => {
    it("adds the date to a series that had no skips", () => {
        const skipped = skipOccurrence(gym(weekly), "2026-03-24");
        expect(skipped).toMatchObject({
            type: "recurring",
            skipDates: ["2026-03-24"],
        });
    });

    it("keeps the dates already there", () => {
        const skipped = skipOccurrence(
            gym(weekly, { skipDates: ["2026-03-24"] }),
            "2026-04-07"
        );
        expect(skipped).toMatchObject({
            skipDates: ["2026-03-24", "2026-04-07"],
        });
    });

    it("sorts, so the note does not shuffle its own lines between saves", () => {
        const skipped = skipOccurrence(
            gym(weekly, { skipDates: ["2026-04-07"] }),
            "2026-03-24"
        );
        expect(skipped).toMatchObject({
            skipDates: ["2026-03-24", "2026-04-07"],
        });
    });

    it("is idempotent, so deleting the same occurrence twice is a no-op", () => {
        // The occurrence is already gone from the view the second time, but a
        // stale render or a double click should not grow the file.
        const once = skipOccurrence(gym(weekly), "2026-03-24");
        const twice = skipOccurrence(once, "2026-03-24");
        expect(twice).toMatchObject({ skipDates: ["2026-03-24"] });
    });

    it("leaves the rule itself alone", () => {
        const skipped = skipOccurrence(gym(weekly), "2026-03-24");
        expect(skipped).toMatchObject({ recurring: weekly });
    });

    it("works on a hand-written rrule, which skipDates are independent of", () => {
        const skipped = skipOccurrence(
            gym({ start: "2026-03-17", rrule: "FREQ=MONTHLY;BYDAY=3FR" }),
            "2026-04-17"
        );
        expect(skipped).toMatchObject({ skipDates: ["2026-04-17"] });
    });

    it("refuses an event that does not repeat", () => {
        const single = parseEvent({
            title: "Gym",
            allDay: true,
            date: "2026-03-24",
        });
        expect(() => skipOccurrence(single, "2026-03-24")).toThrow(
            "is not a recurring event"
        );
    });

    it("refuses a date YAML would have read as a number", () => {
        expect(() => skipOccurrence(gym(weekly), "20260324")).toThrow(
            "must be an ISO date"
        );
    });
});

describe("ending a series early", () => {
    it("sets until to the day before, so the chosen occurrence is the first one gone", () => {
        const capped = truncateSeriesBefore(gym(weekly), "2026-03-24");
        expect(capped).toMatchObject({
            recurring: { ...weekly, until: "2026-03-23" },
        });
    });

    it("crosses a month boundary correctly", () => {
        const capped = truncateSeriesBefore(gym(weekly), "2026-04-01");
        expect(capped).toMatchObject({ recurring: { until: "2026-03-31" } });
    });

    it("drops count, which would contradict the until it just set", () => {
        // compileRecurrence refuses a rule carrying both, so leaving the count
        // would take the series off the calendar entirely.
        const capped = truncateSeriesBefore(
            gym({ ...weekly, count: 10 }),
            "2026-03-24"
        );
        expect(capped?.type === "recurring" && capped.recurring).toMatchObject({
            until: "2026-03-23",
        });
        expect(
            capped?.type === "recurring" && capped.recurring.count
        ).toBeUndefined();
    });

    it("replaces an until that was already there", () => {
        const capped = truncateSeriesBefore(
            gym({ ...weekly, until: "2026-12-31" }),
            "2026-03-24"
        );
        expect(capped).toMatchObject({ recurring: { until: "2026-03-23" } });
    });

    it("answers null at the first occurrence, since nothing would be left", () => {
        // Truncating from the start is a request for the series to stop
        // existing. The caller deletes the master rather than writing a rule
        // that generates nothing.
        expect(truncateSeriesBefore(gym(weekly), "2026-03-17")).toBeNull();
    });

    it("answers null before the first occurrence too", () => {
        expect(truncateSeriesBefore(gym(weekly), "2026-03-10")).toBeNull();
    });

    it("refuses a hand-written rrule rather than setting an until it would ignore", () => {
        // compileRecurrence returns the raw string in place of the structured
        // fields, so an until beside one never reaches the compiled rule.
        expect(() =>
            truncateSeriesBefore(
                gym({ start: "2026-03-17", rrule: "FREQ=MONTHLY;BYDAY=3FR" }),
                "2026-04-17"
            )
        ).toThrow("hand-written rrule");
    });

    it("refuses an event that does not repeat", () => {
        const single = parseEvent({
            title: "Gym",
            allDay: true,
            date: "2026-03-24",
        });
        expect(() => truncateSeriesBefore(single, "2026-03-24")).toThrow(
            "is not a recurring event"
        );
    });
});

describe("stamping an override", () => {
    const parent = "[[_recurring/20260317_Gym]]";

    /** The occurrence as the modal hands it back: an ordinary single event. */
    const edited = (extra: Record<string, unknown> = {}) =>
        parseEvent({
            title: "Gym",
            allDay: false,
            date: "2026-03-24",
            startTime: "06:30",
            endTime: "07:30",
            ...extra,
        });

    it("records the occurrence it replaces and the master it belongs to", () => {
        const override = overrideOf(edited(), "2026-03-24", parent);
        expect(override).toMatchObject({
            type: "single",
            recurrenceId: "2026-03-24",
            recurringParent: parent,
        });
    });

    it("keeps the date the user moved it to, not the one it replaces", () => {
        // PLANNING §9.1: a moved override lives on its new date, which is where
        // you would look for it, and recurrenceId remembers the original. The
        // two differing is the normal case, not a mistake to reconcile.
        const override = overrideOf(
            edited({ date: "2026-03-25" }),
            "2026-03-24",
            parent
        );
        expect(override).toMatchObject({
            date: "2026-03-25",
            recurrenceId: "2026-03-24",
        });
    });

    it("carries the edit itself", () => {
        const override = overrideOf(
            edited({ title: "Gym (late)", startTime: "19:00" }),
            "2026-03-24",
            parent
        );
        expect(override).toMatchObject({
            title: "Gym (late)",
            startTime: "19:00",
        });
    });

    it("produces something the rest of the plugin recognises as an override", () => {
        // Both fields or neither: parseEvent refuses half a pair, so a result
        // that survives a round trip is one the write path can store.
        const override = overrideOf(edited(), "2026-03-24", parent);
        expect(isOverride(override)).toBe(true);
        expect(isOverride(parseEvent({ ...override }))).toBe(true);
    });

    it("refuses to override an occurrence with a series", () => {
        expect(() => overrideOf(gym(weekly), "2026-03-24", parent)).toThrow(
            "has to be a single event"
        );
    });

    it("refuses a date YAML would have read as a number", () => {
        expect(() => overrideOf(edited(), "20260324", parent)).toThrow(
            "must be an ISO date"
        );
    });
});

describe("starting a new series from a split", () => {
    it("takes the edit date as its start", () => {
        const next = seriesFrom(gym(weekly), "2026-03-24");
        expect(next).toMatchObject({
            recurring: { ...weekly, start: "2026-03-24" },
        });
    });

    it("carries the edited title and times", () => {
        const edited = gym(weekly, {});
        const next = seriesFrom(
            { ...edited, title: "Gym (evenings)" },
            "2026-03-24"
        );
        expect(next).toMatchObject({
            title: "Gym (evenings)",
            startTime: "06:30",
        });
    });

    it("drops count, which counted occurrences of the original series", () => {
        const next = seriesFrom(gym({ ...weekly, count: 10 }), "2026-03-24");
        expect(
            next.type === "recurring" && next.recurring.count
        ).toBeUndefined();
    });

    it("keeps until, since the end of the series has not moved", () => {
        const next = seriesFrom(
            gym({ ...weekly, until: "2026-12-31" }),
            "2026-03-24"
        );
        expect(next).toMatchObject({
            recurring: { until: "2026-12-31", start: "2026-03-24" },
        });
    });

    it("refuses an event that does not repeat", () => {
        const single = parseEvent({
            title: "Gym",
            allDay: true,
            date: "2026-03-24",
        });
        expect(() => seriesFrom(single, "2026-03-24")).toThrow(
            "is not a recurring event"
        );
    });
});
