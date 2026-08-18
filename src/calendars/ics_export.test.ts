import { DateTime } from "luxon";

import { parseEvent } from "../types/schema";
import { exportToIcs, ExportEntry, ExportOptions } from "./ics_export";

/**
 * Rendering events as an iCalendar file.
 *
 * The file is read by a subscriber on a phone, not by this plugin, so what
 * these pin is the wire format: which properties appear, in what form, and what
 * never appears at all. Nothing here expands a rule or needs a pinned timezone
 * — times are floating by design, which is the point.
 */

const NOW = DateTime.fromISO("2026-03-01T09:00:00Z", { zone: "utc" });

const options = (extra: Partial<ExportOptions> = {}): ExportOptions => ({
    calendarName: "Social",
    reminderMinutes: null,
    now: NOW,
    ...extra,
});

const entry = (event: unknown, uid = "gym-uid"): ExportEntry => ({
    event: parseEvent(event as Record<string, unknown>),
    uid,
});

/** The exported file, split into unfolded content lines. */
const linesOf = (entries: ExportEntry[], opts = options()): string[] =>
    exportToIcs(entries, opts)
        .split("\r\n")
        // Undo folding, so a test asserts on properties rather than on layout.
        .reduce<string[]>((acc, line) => {
            if (line.startsWith(" ") && acc.length > 0) {
                acc[acc.length - 1] += line.slice(1);
                return acc;
            }
            return [...acc, line];
        }, [])
        .filter((line) => line.length > 0);

const timed = {
    title: "Gym",
    allDay: false,
    date: "2026-03-17",
    startTime: "06:30",
    endTime: "07:30",
};

const series = {
    title: "Gym",
    allDay: false,
    startTime: "06:30",
    endTime: "07:30",
    recurring: { start: "2026-03-17", freq: "weekly", byDay: ["TU"] },
};

describe("the file itself", () => {
    it("is a calendar a subscriber will recognise", () => {
        const lines = linesOf([entry(timed)]);
        expect(lines[0]).toBe("BEGIN:VCALENDAR");
        expect(lines).toContain("VERSION:2.0");
        expect(lines).toContain("CALSCALE:GREGORIAN");
        expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    });

    it("ends every line with CRLF, including the last", () => {
        // Some parsers reject a file whose final line is unterminated.
        const text = exportToIcs([entry(timed)], options());
        expect(text.endsWith("\r\n")).toBe(true);
        expect(text.split("\n").every((l) => l === "" || l.endsWith("\r")));
    });

    it("offers a calendar name, which is only ever a hint", () => {
        expect(linesOf([])).toContain("X-WR-CALNAME:Social");
    });

    it("holds no events when there are none", () => {
        expect(linesOf([]).some((l) => l.startsWith("BEGIN:VEVENT"))).toBe(
            false
        );
    });
});

describe("a single event", () => {
    it("carries a UID, which is what makes a re-export an update", () => {
        expect(linesOf([entry(timed)])).toContain("UID:gym-uid");
    });

    it("is timed in floating time, with no Z and no TZID", () => {
        // 06:30 means 06:30 wherever the phone is. A Z here would shift the
        // event by the local offset, and across a DST boundary it would shift
        // only half the year.
        const lines = linesOf([entry(timed)]);
        expect(lines).toContain("DTSTART:20260317T063000");
        expect(lines).toContain("DTEND:20260317T073000");
    });

    it("omits DTEND rather than inventing a duration", () => {
        const lines = linesOf([
            entry({ ...timed, endTime: null } as Record<string, unknown>),
        ]);
        expect(lines).toContain("DTSTART:20260317T063000");
        expect(lines.some((l) => l.startsWith("DTEND"))).toBe(false);
    });

    it("ends an all-day event on the following day, since DTEND is exclusive", () => {
        const lines = linesOf([
            entry({ title: "Holiday", allDay: true, date: "2026-03-17" }),
        ]);
        expect(lines).toContain("DTSTART;VALUE=DATE:20260317");
        expect(lines).toContain("DTEND;VALUE=DATE:20260318");
    });

    it("keeps a multi-day event the length it was written", () => {
        // endDate names the last day covered; DTEND names the first day not.
        const lines = linesOf([
            entry({
                title: "Boatweek",
                allDay: true,
                date: "2026-03-17",
                endDate: "2026-03-20",
            }),
        ]);
        expect(lines).toContain("DTSTART;VALUE=DATE:20260317");
        expect(lines).toContain("DTEND;VALUE=DATE:20260321");
    });

    it("stamps the file with a real UTC time, unlike the events", () => {
        expect(linesOf([entry(timed)])).toContain("DTSTAMP:20260301T090000Z");
    });
});

describe("a series", () => {
    it("starts at the rule's start, not at some occurrence of it", () => {
        const lines = linesOf([entry(series)]);
        expect(lines).toContain("DTSTART:20260317T063000");
        expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
    });

    it("passes a hand-written rule through as authored", () => {
        const lines = linesOf([
            entry({
                ...series,
                recurring: {
                    start: "2026-03-17",
                    rrule: "FREQ=MONTHLY;BYDAY=3FR",
                },
            }),
        ]);
        expect(lines).toContain("RRULE:FREQ=MONTHLY;BYDAY=3FR");
    });

    it("cancels a skipped occurrence at the time the rule generates it", () => {
        // An EXDATE that misses its occurrence by an hour cancels nothing.
        const lines = linesOf([
            entry({ ...series, skipDates: ["2026-03-24", "2026-04-07"] }),
        ]);
        expect(lines).toContain("EXDATE:20260324T063000,20260407T063000");
    });

    it("cancels an all-day occurrence by date alone", () => {
        const lines = linesOf([
            entry({
                title: "Bins",
                allDay: true,
                recurring: {
                    start: "2026-03-17",
                    freq: "weekly",
                    byDay: ["TU"],
                },
                skipDates: ["2026-03-24"],
            }),
        ]);
        expect(lines).toContain("EXDATE;VALUE=DATE:20260324");
    });
});

describe("an override", () => {
    const master = parseEvent(series);

    const override = (extra: Record<string, unknown> = {}): ExportEntry => ({
        event: parseEvent({
            title: "Gym (late)",
            allDay: false,
            date: "2026-03-25",
            startTime: "19:00",
            endTime: "20:00",
            recurrenceId: "2026-03-24",
            recurringParent: "[[_recurring/20260317_Gym]]",
            ...extra,
        }),
        uid: "override-uid",
        parent: { uid: "gym-uid", event: master },
    });

    it("takes the master's UID, so it replaces rather than joins", () => {
        // Its own UID is not used: a separate UID would make it a second event
        // beside the occurrence it is meant to stand in for.
        const lines = linesOf([override()]);
        expect(lines).toContain("UID:gym-uid");
        expect(lines).not.toContain("UID:override-uid");
    });

    it("names the occurrence in the master's terms, not its own", () => {
        // The override has moved to the 25th at 19:00; what it replaces is the
        // 24th at 06:30, which only the master knows.
        const lines = linesOf([override()]);
        expect(lines).toContain("RECURRENCE-ID:20260324T063000");
        expect(lines).toContain("DTSTART:20260325T190000");
    });

    it("names an all-day occurrence by date", () => {
        const allDayMaster = parseEvent({
            title: "Bins",
            allDay: true,
            recurring: { start: "2026-03-17", freq: "weekly", byDay: ["TU"] },
        });
        const lines = linesOf([
            {
                event: parseEvent({
                    title: "Bins (early)",
                    allDay: true,
                    date: "2026-03-23",
                    recurrenceId: "2026-03-24",
                    recurringParent: "[[_recurring/20260317_Bins]]",
                }),
                uid: "override-uid",
                parent: { uid: "bins-uid", event: allDayMaster },
            },
        ]);
        expect(lines).toContain("RECURRENCE-ID;VALUE=DATE:20260324");
    });

    it("refuses to export one whose series was not found", () => {
        // Emitted alone it would carry its own UID, leaving the generated
        // occurrence standing beside it — the day shown twice, which is the
        // failure overrides exist to prevent.
        const orphan = { ...override(), parent: undefined };
        expect(() => exportToIcs([orphan], options())).toThrow(
            "could not be found"
        );
    });
});

describe("the alarm, which is the whole point", () => {
    it("is emitted at the lead time asked for", () => {
        const lines = linesOf([entry(timed)], options({ reminderMinutes: 15 }));
        expect(lines).toContain("BEGIN:VALARM");
        expect(lines).toContain("ACTION:DISPLAY");
        expect(lines).toContain("TRIGGER:-PT15M");
        expect(lines).toContain("END:VALARM");
    });

    it("is left out when no reminder is wanted", () => {
        const lines = linesOf([entry(timed)], options({ reminderMinutes: 0 }));
        expect(lines.some((l) => l === "BEGIN:VALARM")).toBe(false);
    });

    it("is left out when reminders are off entirely", () => {
        const lines = linesOf([entry(timed)]);
        expect(lines.some((l) => l === "BEGIN:VALARM")).toBe(false);
    });
});

describe("what must never leave the vault", () => {
    it("exports no description, since that is where the private content is", () => {
        const lines = linesOf([entry(timed)], options({ reminderMinutes: 15 }));
        // The alarm carries one, naming the event. Nothing else does.
        expect(lines.filter((l) => l.startsWith("DESCRIPTION"))).toEqual([
            "DESCRIPTION:Gym",
        ]);
    });

    it("flattens a wikilink in a title to its displayed half", () => {
        const lines = linesOf([
            entry({ ...timed, title: "Coffee with [[PEOPLE/Sam Owens|Sam]]" }),
        ]);
        expect(lines).toContain("SUMMARY:Coffee with Sam");
    });

    it("keeps the name but drops the path when there is no alias", () => {
        const lines = linesOf([
            entry({ ...timed, title: "Coffee with [[PEOPLE/Sam Owens]]" }),
        ]);
        expect(lines).toContain("SUMMARY:Coffee with Sam Owens");
        expect(
            exportToIcs([entry({ ...timed, title: "[[A/B]]" })], options())
        ).not.toContain("A/B");
    });

    it("refuses a compiled rrule event, which never comes from a note", () => {
        expect(() =>
            exportToIcs(
                [
                    {
                        event: parseEvent({
                            title: "Remote",
                            allDay: true,
                            type: "rrule",
                            startDate: "2026-03-17",
                            rrule: "FREQ=WEEKLY",
                            skipDates: [],
                        }),
                        uid: "remote-uid",
                    },
                ],
                options()
            )
        ).toThrow("compiled rrule event");
    });
});

describe("the wire format's sharp edges", () => {
    it("escapes the characters that would otherwise end a value", () => {
        const lines = linesOf([
            entry({ ...timed, title: "Drinks; food, and a \\ backslash" }),
        ]);
        expect(lines).toContain(
            "SUMMARY:Drinks\\; food\\, and a \\\\ backslash"
        );
    });

    it("folds a long line, and it unfolds back to what went in", () => {
        const title = "x".repeat(200);
        const text = exportToIcs([entry({ ...timed, title })], options());
        const raw = text.split("\r\n");

        expect(raw.some((l) => l.startsWith(" "))).toBe(true);
        expect(raw.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(
            true
        );
        expect(linesOf([entry({ ...timed, title })])).toContain(
            `SUMMARY:${title}`
        );
    });

    it("folds on octets, not characters", () => {
        // A line of em dashes is three times longer in UTF-8 than it looks;
        // counting characters would push each folded line over the limit.
        const title = "—".repeat(60);
        const raw = exportToIcs([entry({ ...timed, title })], options()).split(
            "\r\n"
        );
        expect(raw.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(
            true
        );
    });
});
