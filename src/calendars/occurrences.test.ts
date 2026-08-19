import { DateTime, Settings } from "luxon";

import { parseEvent } from "../types/schema";
import { FerryEvent } from "../types";
import { occurrencesInWindow, StoredEntry } from "./occurrences";

/**
 * Expanding events into the times they actually happen at.
 *
 * Pinned to a zone well east of Greenwich, for the reason `ui/interop.test.ts`
 * is: the `rrule` package reads DTSTART's **UTC components** as a wall-clock
 * time, so a rule built from local midnight is a different day to it. In Sydney
 * that mistake is a visible day early on every occurrence; in UTC it hides.
 */

const SYDNEY = "Australia/Sydney";

beforeAll(() => {
    Settings.defaultZone = SYDNEY;
});

afterAll(() => {
    Settings.defaultZone = "system";
});

const at = (iso: string) => DateTime.fromISO(iso, { zone: SYDNEY });

/** An entry as the cache would hold it, with the frontmatter really parsed. */
const entry = (
    id: string,
    frontmatter: Record<string, unknown>,
    calendarId = "cal"
): StoredEntry => ({
    id,
    calendarId,
    event: parseEvent(frontmatter) as FerryEvent,
});

const startsOf = (occurrences: { start: DateTime }[]) =>
    occurrences.map(({ start }) => start.toISO({ suppressMilliseconds: true }));

describe("single events", () => {
    it("returns an all-day event that falls inside the window", () => {
        const found = occurrencesInWindow(
            [entry("1", { title: "Flight", allDay: true, date: "2026-03-17" })],
            at("2026-03-16T00:00"),
            at("2026-03-18T00:00")
        );

        expect(found).toHaveLength(1);
        expect(found[0].start.toISODate()).toBe("2026-03-17");
        expect(found[0].allDay).toBe(true);
    });

    it("leaves out an event outside the window", () => {
        const entries = [
            entry("1", { title: "Flight", allDay: true, date: "2026-03-17" }),
        ];

        expect(
            occurrencesInWindow(
                entries,
                at("2026-04-01T00:00"),
                at("2026-04-30T00:00")
            )
        ).toEqual([]);
    });

    it("places a timed event at its local wall-clock time", () => {
        const found = occurrencesInWindow(
            [
                entry("1", {
                    title: "Standup",
                    date: "2026-03-17",
                    startTime: "09:00",
                    endTime: "09:30",
                }),
            ],
            at("2026-03-17T00:00"),
            at("2026-03-18T00:00")
        );

        expect(startsOf(found)).toEqual(["2026-03-17T09:00:00+11:00"]);
        expect(found[0].end?.toISO({ suppressMilliseconds: true })).toBe(
            "2026-03-17T09:30:00+11:00"
        );
    });

    it("keeps a multi-day event that is already under way", () => {
        const found = occurrencesInWindow(
            [
                entry("1", {
                    title: "Boat week",
                    allDay: true,
                    date: "2026-03-10",
                    endDate: "2026-03-20",
                }),
            ],
            at("2026-03-15T00:00"),
            at("2026-03-16T00:00")
        );

        expect(found).toHaveLength(1);
    });

    it("runs a timed event to its end date, not to the end of its start time", () => {
        const overnight = entry("1", {
            title: "Ferry",
            date: "2026-03-17",
            startTime: "22:00",
            endDate: "2026-03-18",
            endTime: "06:00",
        });

        // Subtracting the times would give minus sixteen hours and drop the
        // end altogether; the crossing really does finish the next morning.
        const found = occurrencesInWindow(
            [overnight],
            at("2026-03-17T00:00"),
            at("2026-03-18T00:00")
        );
        expect(found[0].end?.toISO({ suppressMilliseconds: true })).toBe(
            "2026-03-18T06:00:00+11:00"
        );

        // And it is still under way in a window that opens after it started.
        expect(
            occurrencesInWindow(
                [overnight],
                at("2026-03-18T02:00"),
                at("2026-03-18T03:00")
            )
        ).toHaveLength(1);
    });

    it("gives an event with no end time a null end rather than inventing one", () => {
        const found = occurrencesInWindow(
            [
                entry("1", {
                    title: "Call",
                    date: "2026-03-17",
                    startTime: "09:00",
                }),
            ],
            at("2026-03-17T00:00"),
            at("2026-03-18T00:00")
        );

        expect(found[0].end).toBeNull();
    });
});

describe("recurring events", () => {
    const gym = (extra: Record<string, unknown> = {}) =>
        entry("master", {
            title: "Gym",
            allDay: true,
            recurring: { start: "2026-03-17", freq: "weekly", byDay: ["TU"] },
            ...extra,
        });

    it("expands a weekly series onto the right days", () => {
        const found = occurrencesInWindow(
            [gym()],
            at("2026-03-16T00:00"),
            at("2026-04-08T00:00")
        );

        expect(found.map((o) => o.start.toISODate())).toEqual([
            "2026-03-17",
            "2026-03-24",
            "2026-03-31",
            "2026-04-07",
        ]);
    });

    it("expands nothing outside the window, however long the series runs", () => {
        // The point of the window: "every Tuesday forever" costs one week here.
        const found = occurrencesInWindow(
            [gym()],
            at("2026-03-16T00:00"),
            at("2026-03-23T00:00")
        );

        expect(found).toHaveLength(1);
    });

    it("honours the event's own skipDates", () => {
        const found = occurrencesInWindow(
            [gym({ skipDates: ["2026-03-24"] })],
            at("2026-03-16T00:00"),
            at("2026-04-01T00:00")
        );

        expect(found.map((o) => o.start.toISODate())).toEqual([
            "2026-03-17",
            "2026-03-31",
        ]);
    });

    it("cancels the occurrences an override replaces", () => {
        const found = occurrencesInWindow(
            [gym()],
            at("2026-03-16T00:00"),
            at("2026-04-01T00:00"),
            new Map([["master", ["2026-03-24"]]])
        );

        expect(found.map((o) => o.start.toISODate())).toEqual([
            "2026-03-17",
            "2026-03-31",
        ]);
    });

    it("places a timed series at its wall-clock time, not shifted by the offset", () => {
        const found = occurrencesInWindow(
            [
                entry("master", {
                    title: "Standup",
                    recurring: {
                        start: "2026-03-17",
                        freq: "weekly",
                        byDay: ["TU"],
                    },
                    startTime: "09:00",
                    endTime: "09:30",
                }),
            ],
            at("2026-03-16T00:00"),
            at("2026-03-25T00:00")
        );

        expect(startsOf(found)).toEqual([
            "2026-03-17T09:00:00+11:00",
            "2026-03-24T09:00:00+11:00",
        ]);
        expect(found[1].end?.toISO({ suppressMilliseconds: true })).toBe(
            "2026-03-24T09:30:00+11:00"
        );
    });

    it("stops at until", () => {
        const found = occurrencesInWindow(
            [
                gym({
                    recurring: {
                        start: "2026-03-17",
                        freq: "weekly",
                        byDay: ["TU"],
                        until: "2026-03-24",
                    },
                }),
            ],
            at("2026-03-16T00:00"),
            at("2026-05-01T00:00")
        );

        expect(found.map((o) => o.start.toISODate())).toEqual([
            "2026-03-17",
            "2026-03-24",
        ]);
    });

    it("leaves out a series whose rule will not compile, rather than guessing", () => {
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            const found = occurrencesInWindow(
                [
                    entry("master", {
                        title: "Broken",
                        allDay: true,
                        recurring: {
                            start: "2026-03-17",
                            freq: "weekly",
                            count: 3,
                            until: "2026-05-01",
                        },
                    }),
                ],
                at("2026-03-16T00:00"),
                at("2026-05-01T00:00")
            );

            expect(found).toEqual([]);
            expect(error).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });
});

describe("events that cannot be read", () => {
    it("leaves out an unreadable rule rather than throwing", () => {
        const broken: StoredEntry = {
            id: "broken",
            calendarId: "cal",
            // Not built through `parseEvent`: this is the shape a remote
            // calendar or a hand-edited note produces, and the point is that
            // nothing has vetted the rule.
            event: {
                title: "Nonsense",
                type: "rrule",
                allDay: true,
                rrule: "FREQ=NOTAFREQ",
                startDate: "2026-03-17",
                skipDates: [],
            } as unknown as FerryEvent,
        };
        const good = entry("good", {
            title: "Standup",
            date: "2026-03-17",
            startTime: "09:00",
        });

        const found = occurrencesInWindow(
            [broken, good],
            at("2026-03-17T00:00"),
            at("2026-03-18T00:00")
        );

        // The broken event is absent and the good one still answered — one
        // unreadable rule must not silence the rest of the calendar.
        expect(found.map((o) => o.event.title)).toEqual(["Standup"]);
    });
});

describe("the answer as a whole", () => {
    it("sorts everything by when it starts, across events and calendars", () => {
        const found = occurrencesInWindow(
            [
                entry("late", {
                    title: "Dinner",
                    date: "2026-03-17",
                    startTime: "19:00",
                }),
                entry(
                    "series",
                    {
                        title: "Gym",
                        recurring: {
                            start: "2026-03-17",
                            freq: "daily",
                        },
                        startTime: "06:00",
                    },
                    "other"
                ),
                entry("early", {
                    title: "Standup",
                    date: "2026-03-17",
                    startTime: "09:00",
                }),
            ],
            at("2026-03-17T00:00"),
            at("2026-03-18T12:00")
        );

        // The second Gym is the next day's occurrence of the daily series,
        // which is inside this window and after everything on the 17th.
        expect(found.map((o) => o.event.title)).toEqual([
            "Gym",
            "Standup",
            "Dinner",
            "Gym",
        ]);
    });

    it("carries the calendar each occurrence came from", () => {
        const found = occurrencesInWindow(
            [
                entry(
                    "1",
                    { title: "Flight", allDay: true, date: "2026-03-17" },
                    "work"
                ),
            ],
            at("2026-03-16T00:00"),
            at("2026-03-18T00:00")
        );

        expect(found[0].calendarId).toBe("work");
    });
});
