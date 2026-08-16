import {
    CommonSchema,
    EventSchema,
    FerryEvent,
    ParsedDate,
    ParsedTime,
    TimeSchema,
    parseEvent,
    serializeEvent,
} from "./schema";
import fc from "fast-check";
import { ZodFastCheck } from "zod-fast-check";

describe("schema parsing tests", () => {
    describe("single events", () => {
        it("simplest", () => {
            expect(
                parseEvent({
                    title: "Test",
                    date: "2021-01-01",
                    allDay: true,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("explicit type", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: true,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("truncates time from date", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: true,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("start time", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01T10:30:00.000Z",
                    allDay: false,
                    startTime: "10:30",
                    endTime: null,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": false,
                  "date": "2021-01-01T10:30:00.000Z",
                  "endDate": null,
                  "endTime": null,
                  "startTime": "10:30",
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("am/pm start time", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: false,
                    startTime: "10:30 pm",
                    endTime: null,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": false,
                  "date": "2021-01-01",
                  "endDate": null,
                  "endTime": null,
                  "startTime": "10:30 pm",
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("end time", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: false,
                    startTime: "10:30",
                    endTime: "11:45",
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": false,
                  "date": "2021-01-01",
                  "endDate": null,
                  "endTime": "11:45",
                  "startTime": "10:30",
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("multi-day events", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    endDate: "2021-01-03",
                    allDay: true,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "date": "2021-01-01",
                  "endDate": "2021-01-03",
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("to-do", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: true,
                    completed: null,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "completed": null,
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("to-do unchecked", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: true,
                    completed: false,
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "completed": false,
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
        it("to-do completed", () => {
            expect(
                parseEvent({
                    title: "Test",
                    type: "single",
                    date: "2021-01-01",
                    allDay: true,
                    completed: "2021-01-01T10:30:00.000Z",
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "completed": "2021-01-01T10:30:00.000Z",
                  "date": "2021-01-01",
                  "endDate": null,
                  "title": "Test",
                  "type": "single",
                }
            `);
        });
    });
    describe("recurring events", () => {
        it("infers the type from the authored block", () => {
            // No `type` key: §3.1's frontmatter does not have one, and the
            // presence of a rule is what makes an event recurring.
            expect(
                parseEvent({
                    title: "Gym",
                    allDay: true,
                    recurring: {
                        start: "2026-03-17",
                        freq: "weekly",
                        byDay: ["TU", "TH"],
                        count: 10,
                    },
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "recurring": {
                    "byDay": [
                      "TU",
                      "TH",
                    ],
                    "count": 10,
                    "freq": "weekly",
                    "start": "2026-03-17",
                  },
                  "title": "Gym",
                  "type": "recurring",
                }
            `);
        });

        it("keeps skipDates alongside the rule", () => {
            expect(
                parseEvent({
                    title: "Gym",
                    allDay: true,
                    recurring: { start: "2026-03-17", freq: "weekly" },
                    skipDates: ["2026-03-26"],
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "recurring": {
                    "freq": "weekly",
                    "start": "2026-03-17",
                  },
                  "skipDates": [
                    "2026-03-26",
                  ],
                  "title": "Gym",
                  "type": "recurring",
                }
            `);
        });

        it("rejects a skipDate that YAML read as a number", () => {
            // `skipDates: [20260326]` unquoted is a list of integers, not of
            // dates, and silently dropping it would mean an occurrence the user
            // deleted coming back.
            expect(() =>
                parseEvent({
                    title: "Gym",
                    allDay: true,
                    recurring: { start: "2026-03-17", freq: "weekly" },
                    skipDates: [20260326],
                })
            ).toThrow("an unquoted 20260326 is a number to YAML");
        });

        it("upgrades the inherited weekday shape", () => {
            expect(
                parseEvent({
                    title: "Test",
                    allDay: true,
                    type: "recurring",
                    daysOfWeek: ["M", "W"],
                    startRecur: "2023-01-05",
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "recurring": {
                    "byDay": [
                      "MO",
                      "WE",
                    ],
                    "freq": "weekly",
                    "start": "2023-01-05",
                  },
                  "title": "Test",
                  "type": "recurring",
                }
            `);
        });

        it("upgrades an inherited end date to until", () => {
            expect(
                parseEvent({
                    title: "Test",
                    allDay: true,
                    type: "recurring",
                    daysOfWeek: ["M"],
                    startRecur: "2023-01-05",
                    endRecur: "2023-05-12",
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "recurring": {
                    "byDay": [
                      "MO",
                    ],
                    "freq": "weekly",
                    "start": "2023-01-05",
                    "until": "2023-05-12",
                  },
                  "title": "Test",
                  "type": "recurring",
                }
            `);
        });

        it("refuses an inherited rule with no start date", () => {
            // The authored form makes DTSTART mandatory, so there is nowhere
            // for a startless series to go. Failing here is better than filing
            // it under a start date the plugin invented.
            expect(() =>
                parseEvent({
                    title: "Test",
                    allDay: true,
                    type: "recurring",
                    daysOfWeek: ["M"],
                })
            ).toThrow("A recurring event needs a start date");
        });

        it("prefers the authored block when a note carries both", () => {
            // The block is what the plugin writes, so it is the newer of the
            // two descriptions.
            expect(
                parseEvent({
                    title: "Test",
                    allDay: true,
                    type: "recurring",
                    daysOfWeek: ["M"],
                    startRecur: "2023-01-05",
                    recurring: { start: "2026-03-17", freq: "daily" },
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "recurring": {
                    "freq": "daily",
                    "start": "2026-03-17",
                  },
                  "title": "Test",
                  "type": "recurring",
                }
            `);
        });
    });
    describe("rrule events", () => {
        it("basic rrule", () => {
            expect(
                parseEvent({
                    title: "Test",
                    allDay: true,
                    type: "rrule",
                    id: "hi",
                    rrule: "RRULE",
                    skipDates: [],
                    startDate: "2023-01-05",
                })
            ).toMatchInlineSnapshot(`
                {
                  "allDay": true,
                  "id": "hi",
                  "rrule": "RRULE",
                  "skipDates": [],
                  "startDate": "2023-01-05",
                  "title": "Test",
                  "type": "rrule",
                }
            `);
        });
    });

    describe("property-based tests", () => {
        const zfc = ZodFastCheck()
            .override(
                ParsedDate,
                fc
                    .date({
                        min: new Date(2000, 0, 0),
                        max: new Date(2150, 0, 0),
                    })
                    .map(
                        (date) =>
                            `${date.getFullYear()}-${(date.getMonth() + 1)
                                .toString()
                                .padStart(2, "0")}-${date
                                .getDate()
                                .toString()
                                .padStart(2, "0")}`
                    )
            )
            .override(
                ParsedTime,
                fc
                    .date()
                    .map(
                        (date) =>
                            `${date
                                .getHours()
                                .toString()
                                .padStart(2, "0")}:${date
                                .getMinutes()
                                .toString()
                                .padStart(2, "0")}`
                    )
            );

        it("parses", () => {
            const CommonArb = zfc.inputOf(CommonSchema);
            const TimeArb = zfc.inputOf(TimeSchema);
            const EventArb = zfc.inputOf(EventSchema);
            const EventInputArbitrary = fc
                .tuple(CommonArb, TimeArb, EventArb)
                .map(([common, time, event]) => ({
                    ...common,
                    ...time,
                    ...event,
                }));

            fc.assert(
                fc.property(EventInputArbitrary, (obj) => {
                    expect(() => parseEvent(obj)).not.toThrow();
                })
            );
        });

        it("roundtrips", () => {
            const CommonArb = zfc.outputOf(CommonSchema);
            const TimeArb = zfc.outputOf(TimeSchema);
            const EventArb = zfc.outputOf(EventSchema);
            const FerryEventArbitrary: fc.Arbitrary<FerryEvent> = fc
                .tuple(CommonArb, TimeArb, EventArb)
                .map(([common, time, event]) => ({
                    ...common,
                    ...time,
                    ...event,
                }));

            fc.assert(
                fc.property(FerryEventArbitrary, (event) => {
                    const obj = serializeEvent(event);
                    const newParsedEvent = parseEvent(obj);
                    expect(newParsedEvent).toEqual(event);
                })
            );
        });
    });
});
