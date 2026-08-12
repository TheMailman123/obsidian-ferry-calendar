import {
    DerivedMapping,
    derivedMappingSchema,
    isAbsent,
    mapNoteToEvent,
    NoteRef,
    parseDateValue,
    renderTitle,
    summarizeOutcomes,
} from "./derived";
import { validateEvent } from "../../types";

/*
 * Fixtures here are synthetic and deliberately domain-neutral. The two shapes
 * exercised below — a single date projected yearly, and a start/end pair
 * spanning several days — are the two a generic mapping has to handle between
 * them; neither the mapper nor these tests know what the notes are records of.
 */

const note: NoteRef = {
    basename: "Fixture One",
    path: "RECORDS/Fixture One.md",
};

/** A mapping with the schema's defaults filled in, overridable per test. */
const mapping = (overrides: Partial<DerivedMapping> = {}): DerivedMapping =>
    derivedMappingSchema.parse({ start: "DATE", ...overrides });

const eventFrom = (outcome: ReturnType<typeof mapNoteToEvent>) => {
    if (outcome.status !== "event") {
        throw new Error(
            `Expected an event but got ${outcome.status}: ${
                "reason" in outcome ? outcome.reason : ""
            }`
        );
    }
    return outcome.event;
};

describe("mapping defaults", () => {
    it("fills in every optional field from a bare mapping", () => {
        expect(derivedMappingSchema.parse({ start: "DATE" })).toEqual({
            title: "{{file.basename}}",
            start: "DATE",
            allDay: true,
            repeat: "none",
            dateFormat: "iso",
            skipIfMissing: true,
        });
    });

    it("rejects a mapping with no start property", () => {
        expect(() => derivedMappingSchema.parse({ title: "x" })).toThrow();
        expect(() => derivedMappingSchema.parse({ start: "" })).toThrow();
    });
});

describe("shape: single date projected yearly", () => {
    const yearly = mapping({ repeat: "yearly" });

    it("projects a repeat without writing one", () => {
        expect(mapNoteToEvent({ DATE: "1990-04-12" }, note, yearly)).toEqual({
            status: "event",
            event: {
                title: "Fixture One",
                allDay: true,
                type: "rrule",
                startDate: "1990-04-12",
                rrule: "FREQ=YEARLY",
                skipDates: [],
            },
        });
    });

    it("takes the title from the filename", () => {
        const event = eventFrom(
            mapNoteToEvent({ DATE: "1990-04-12" }, note, yearly)
        );
        expect(event.title).toBe("Fixture One");
    });

    it("passes a raw RRULE through untouched", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { DATE: "1990-04-12" },
                note,
                mapping({ repeat: "FREQ=YEARLY;BYMONTHDAY=12" })
            )
        );
        expect(event).toMatchObject({ rrule: "FREQ=YEARLY;BYMONTHDAY=12" });
    });

    it("reports a repeat that is neither a keyword nor a rule", () => {
        expect(
            mapNoteToEvent(
                { DATE: "1990-04-12" },
                note,
                mapping({ repeat: "yearl" })
            )
        ).toMatchObject({ status: "error" });
    });

    it("refuses to project a repeat across a multi-day span", () => {
        expect(
            mapNoteToEvent(
                { DATE: "1990-04-12", END: "1990-04-15" },
                note,
                mapping({ end: "END", repeat: "yearly" })
            )
        ).toMatchObject({
            status: "error",
            reason: expect.stringContaining("cannot span multiple days"),
        });
    });
});

describe("shape: start and end spanning multiple days", () => {
    const span = mapping({ start: "START_DATE", end: "END_DATE" });

    it("renders the last day of the span", () => {
        // The note says the record ends on the 10th; an all-day end is
        // exclusive, so the calendar has to be told the 11th.
        expect(
            mapNoteToEvent(
                { START_DATE: "2019-06-04", END_DATE: "2019-06-10" },
                note,
                span
            )
        ).toEqual({
            status: "event",
            event: {
                title: "Fixture One",
                allDay: true,
                type: "single",
                date: "2019-06-04",
                endDate: "2019-06-11",
            },
        });
    });

    it("drops an end date equal to the start", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { START_DATE: "2019-06-04", END_DATE: "2019-06-04" },
                note,
                span
            )
        );
        expect(event).toMatchObject({ date: "2019-06-04", endDate: null });
    });

    it("treats an absent end as a single day", () => {
        const event = eventFrom(
            mapNoteToEvent({ START_DATE: "2019-06-04" }, note, span)
        );
        expect(event).toMatchObject({ date: "2019-06-04", endDate: null });
    });

    it("reports an end that precedes the start", () => {
        expect(
            mapNoteToEvent(
                { START_DATE: "2019-06-10", END_DATE: "2019-06-04" },
                note,
                span
            )
        ).toMatchObject({
            status: "error",
            reason: expect.stringContaining("is before"),
        });
    });
});

describe("absent values", () => {
    // The ghost-event regression: an empty property parses to null, not
    // undefined, and both have to count as missing.
    it.each([
        ["missing key", {}],
        ["null value", { DATE: null }],
        ["empty string", { DATE: "" }],
        ["whitespace only", { DATE: "   " }],
        ["no frontmatter at all", undefined],
    ])("skips a note with a %s", (_label, frontmatter) => {
        expect(
            mapNoteToEvent(frontmatter as any, note, mapping())
        ).toMatchObject({ status: "skipped" });
    });

    it("never invents a date from an empty value", () => {
        const outcome = mapNoteToEvent({ DATE: null }, note, mapping());
        expect(outcome.status).not.toBe("event");
    });

    it("reports rather than skips when skipIfMissing is off", () => {
        expect(
            mapNoteToEvent(
                { DATE: null },
                note,
                mapping({ skipIfMissing: false })
            )
        ).toMatchObject({ status: "error" });
    });

    it("agrees with isAbsent about what counts as missing", () => {
        expect(isAbsent(undefined)).toBe(true);
        expect(isAbsent(null)).toBe(true);
        expect(isAbsent("")).toBe(true);
        expect(isAbsent(" ")).toBe(true);
        expect(isAbsent(false)).toBe(false);
        expect(isAbsent(0)).toBe(false);
        expect(isAbsent("2020-01-01")).toBe(false);
    });
});

describe("date parsing", () => {
    it("reads a plain ISO date with no time", () => {
        expect(parseDateValue("2020-05-04", "iso")).toEqual({
            date: "2020-05-04",
            time: null,
        });
    });

    it.each([
        ["T separator", "2020-05-04T09:30"],
        ["space separator", "2020-05-04 09:30"],
        ["with seconds", "2020-05-04T09:30:00"],
    ])("reads a date-time with a %s", (_label, value) => {
        expect(parseDateValue(value, "iso")).toEqual({
            date: "2020-05-04",
            time: "09:30",
        });
    });

    it("reads a Date at UTC midnight as a date with no time", () => {
        // Guards the off-by-one: a YAML date-only value arrives as a Date at
        // UTC midnight and must not slide a day in a negative-offset zone.
        expect(parseDateValue(new Date("2020-05-04T00:00:00Z"), "iso")).toEqual(
            {
                date: "2020-05-04",
                time: null,
            }
        );
    });

    it("reads the time off a Date that has one", () => {
        expect(parseDateValue(new Date("2020-05-04T09:30:00Z"), "iso")).toEqual(
            {
                date: "2020-05-04",
                time: "09:30",
            }
        );
    });

    it("honours a custom date format", () => {
        expect(parseDateValue("04/05/2020", "dd/MM/yyyy")).toEqual({
            date: "2020-05-04",
            time: null,
        });
    });

    it("takes the time from a custom format that has one", () => {
        expect(parseDateValue("04/05/2020 09:30", "dd/MM/yyyy HH:mm")).toEqual({
            date: "2020-05-04",
            time: "09:30",
        });
    });

    it.each([
        ["unparseable text", "sometime in May"],
        ["wrong format", "2020-05-04"],
    ])("reports %s rather than guessing", (_label, value) => {
        expect(parseDateValue(value, "dd/MM/yyyy")).toMatchObject({
            error: expect.any(String),
        });
    });

    it("refuses a number rather than guessing year or timestamp", () => {
        expect(parseDateValue(2019, "iso")).toMatchObject({
            error: expect.any(String),
        });
    });

    it("surfaces an unparseable date as an error, not a skip", () => {
        expect(
            mapNoteToEvent({ DATE: "not a date" }, note, mapping())
        ).toMatchObject({
            status: "error",
            reason: expect.stringContaining("DATE"),
        });
    });
});

describe("times and allDay", () => {
    it("splits a time out of the start date when allDay says so", () => {
        expect(
            mapNoteToEvent(
                { DATE: "2020-05-04T09:30" },
                note,
                mapping({ allDay: false })
            )
        ).toEqual({
            status: "event",
            event: {
                title: "Fixture One",
                allDay: false,
                startTime: "09:30",
                endTime: null,
                type: "single",
                date: "2020-05-04",
                endDate: null,
            },
        });
    });

    it("reads separate time properties", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04", FROM: "9:30 AM", TO: "17:00" },
                note,
                mapping({
                    allDay: false,
                    startTime: "FROM",
                    endTime: "TO",
                })
            )
        );
        expect(event).toMatchObject({
            allDay: false,
            startTime: "09:30",
            endTime: "17:00",
        });
    });

    it("lets an explicit time property win over one in the date", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04T09:30", FROM: "11:00" },
                note,
                mapping({ allDay: false, startTime: "FROM" })
            )
        );
        expect(event).toMatchObject({ startTime: "11:00" });
    });

    it("reads allDay from a named property", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04T09:30", WHOLE_DAY: false },
                note,
                mapping({ allDay: "WHOLE_DAY" })
            )
        );
        expect(event).toMatchObject({ allDay: false, startTime: "09:30" });
    });

    it("accepts a stringified boolean for a named allDay property", () => {
        const event = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04", WHOLE_DAY: "true" },
                note,
                mapping({ allDay: "WHOLE_DAY" })
            )
        );
        expect(event).toMatchObject({ allDay: true });
    });

    it("falls back to whether a time was found when the property is absent", () => {
        const timed = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04T09:30" },
                note,
                mapping({ allDay: "WHOLE_DAY" })
            )
        );
        expect(timed).toMatchObject({ allDay: false, startTime: "09:30" });

        const untimed = eventFrom(
            mapNoteToEvent(
                { DATE: "2020-05-04" },
                note,
                mapping({ allDay: "WHOLE_DAY" })
            )
        );
        expect(untimed).toMatchObject({ allDay: true });
    });

    it("ignores a time when the mapping declares all-day events", () => {
        const event = eventFrom(
            mapNoteToEvent({ DATE: "2020-05-04T09:30" }, note, mapping())
        );
        expect(event).toMatchObject({ allDay: true, date: "2020-05-04" });
    });

    it("reports a timed mapping over a note with no time", () => {
        expect(
            mapNoteToEvent(
                { DATE: "2020-05-04" },
                note,
                mapping({ allDay: false })
            )
        ).toMatchObject({
            status: "error",
            reason: expect.stringContaining("no start time"),
        });
    });

    it("reports an allDay property that is neither true nor false", () => {
        expect(
            mapNoteToEvent(
                { DATE: "2020-05-04", WHOLE_DAY: "sort of" },
                note,
                mapping({ allDay: "WHOLE_DAY" })
            )
        ).toMatchObject({ status: "error" });
    });

    it("reports an unparseable time", () => {
        expect(
            mapNoteToEvent(
                { DATE: "2020-05-04", FROM: "half nine" },
                note,
                mapping({ allDay: false, startTime: "FROM" })
            )
        ).toMatchObject({
            status: "error",
            reason: expect.stringContaining("FROM"),
        });
    });
});

describe("title templating", () => {
    const frontmatter = { DATE: "2020-05-04", LABEL: "From a property" };

    it("renders the filename and path", () => {
        expect(renderTitle("{{file.basename}}", frontmatter, note)).toBe(
            "Fixture One"
        );
        expect(renderTitle("{{file.path}}", frontmatter, note)).toBe(
            "RECORDS/Fixture One.md"
        );
    });

    it("renders a property and mixes in literal text", () => {
        expect(
            renderTitle(
                "[{{property:LABEL}}] {{file.basename}}",
                frontmatter,
                note
            )
        ).toBe("[From a property] Fixture One");
    });

    it("reports a property the note does not set", () => {
        expect(
            renderTitle("{{property:NOPE}}", frontmatter, note)
        ).toMatchObject({ error: expect.stringContaining("NOPE") });
    });

    it("reports an unknown placeholder rather than leaving it in the title", () => {
        expect(renderTitle("{{file.name}}", frontmatter, note)).toMatchObject({
            error: expect.stringContaining("unknown title placeholder"),
        });
    });

    it("reports {{age}} as unsupported rather than rendering it wrong", () => {
        // Deferred deliberately: a projected repeat carries one title for the
        // whole series, so an age would be right on at most one occurrence.
        expect(
            renderTitle("{{property:LABEL}} ({{age}})", frontmatter, note)
        ).toMatchObject({ error: expect.stringContaining("age") });
    });

    it("reports a template that renders to nothing", () => {
        expect(renderTitle("  ", frontmatter, note)).toMatchObject({
            error: expect.any(String),
        });
    });

    it("surfaces a title failure as an error outcome", () => {
        expect(
            mapNoteToEvent(
                frontmatter,
                note,
                mapping({ title: "{{property:NOPE}}" })
            )
        ).toMatchObject({ status: "error" });
    });
});

describe("filters", () => {
    const frontmatter = { DATE: "2020-05-04", STATUS: "active", TAG: null };

    it.each([
        [{ property: "STATUS", op: "exists" as const }, true],
        [{ property: "TAG", op: "exists" as const }, false],
        [{ property: "TAG", op: "missing" as const }, true],
        [{ property: "STATUS", op: "missing" as const }, false],
        [{ property: "STATUS", op: "equals" as const, value: "active" }, true],
        [
            { property: "STATUS", op: "equals" as const, value: "archived" },
            false,
        ],
        [
            { property: "STATUS", op: "notEquals" as const, value: "archived" },
            true,
        ],
        [
            { property: "STATUS", op: "notEquals" as const, value: "active" },
            false,
        ],
    ])("%o admits the note: %s", (filter, admitted) => {
        const outcome = mapNoteToEvent(frontmatter, note, mapping({ filter }));
        expect(outcome.status).toBe(admitted ? "event" : "filtered");
    });

    it("keeps filtered notes distinct from skipped ones", () => {
        // A note excluded on purpose is not a data problem, and lumping the two
        // together would bury real gaps in the preview's skip count.
        const outcome = mapNoteToEvent(
            frontmatter,
            note,
            mapping({ filter: { property: "TAG", op: "exists" } })
        );
        expect(outcome.status).toBe("filtered");
    });
});

describe("produced events are valid events", () => {
    // The cache runs every event through validateEvent() when deciding whether
    // a file changed, and silently drops the ones that fail. An event shape
    // that does not survive that round-trip would look like it changed on
    // every single metadata update.
    it.each([
        ["all-day single", { DATE: "2020-05-04" }, mapping()],
        [
            "all-day span",
            { DATE: "2020-05-04", END: "2020-05-08" },
            mapping({ end: "END" }),
        ],
        [
            "timed single",
            { DATE: "2020-05-04", FROM: "09:30", TO: "17:00" },
            mapping({ allDay: false, startTime: "FROM", endTime: "TO" }),
        ],
        [
            "projected repeat",
            { DATE: "2020-05-04" },
            mapping({ repeat: "yearly" }),
        ],
    ])("%s", (_label, frontmatter, m) => {
        const event = eventFrom(mapNoteToEvent(frontmatter, note, m));
        expect(validateEvent(event)).toEqual(event);
    });
});

describe("summarizing a folder", () => {
    const outcomes = [
        {
            path: "a.md",
            outcome: mapNoteToEvent({ DATE: "2020-01-01" }, note, mapping()),
        },
        {
            path: "b.md",
            outcome: mapNoteToEvent({ DATE: null }, note, mapping()),
        },
        {
            path: "c.md",
            outcome: mapNoteToEvent({ DATE: "nope" }, note, mapping()),
        },
        {
            path: "d.md",
            outcome: mapNoteToEvent(
                { DATE: "2020-01-01", STATUS: "x" },
                note,
                mapping({ filter: { property: "STATUS", op: "missing" } })
            ),
        },
    ];

    it("counts each outcome separately", () => {
        const report = summarizeOutcomes(outcomes);
        expect(report).toMatchObject({
            matched: 1,
            skipped: 1,
            errors: 1,
            filtered: 1,
        });
    });

    it("keeps the reason alongside each sampled path", () => {
        const report = summarizeOutcomes(outcomes);
        expect(report.samples.errors).toEqual([
            { path: "c.md", reason: expect.stringContaining("DATE") },
        ]);
        expect(report.samples.skipped).toEqual([
            { path: "b.md", reason: expect.stringContaining("DATE") },
        ]);
    });

    it("caps the samples it keeps", () => {
        const many = Array.from({ length: 10 }, (_, i) => ({
            path: `${i}.md`,
            outcome: mapNoteToEvent({ DATE: null }, note, mapping()),
        }));
        const report = summarizeOutcomes(many, 3);
        expect(report.skipped).toBe(10);
        expect(report.samples.skipped).toHaveLength(3);
    });
});
