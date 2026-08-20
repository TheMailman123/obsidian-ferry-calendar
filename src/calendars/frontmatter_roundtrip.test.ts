import { load } from "js-yaml";

import { FerryEvent } from "../types";
import { parseEvent, serializeEvent } from "../types/schema";
import { newFrontmatter } from "./frontmatter";

/**
 * What the writer emits, read by a real YAML parser, parsed back as an event.
 *
 * The gap that let PLANNING §13.2 ship. `test_helpers/FileBuilder` writes
 * frontmatter text *and* sets `meta.frontmatter` from the same JavaScript
 * values without ever parsing what it wrote, so every other test in the suite
 * asserts the behaviour of frontmatter the plugin does not produce. An override
 * note was written with an unquoted `[[link]]` — a sequence nested in a
 * sequence to any YAML parser — for as long as the feature existed, and 507
 * green tests had nothing to say about it.
 *
 * So these tests deliberately do the one thing the helpers cannot: they go
 * text → parser → event. `js-yaml` stands in for Obsidian's own reader; it
 * agrees with it on the cases that matter here, keeping `2026-08-26` and
 * `12:30` as strings and reading `[[a/b]]` as `[["a/b"]]`.
 */

/** Write an event out, parse the YAML, and read it back as an event. */
const roundTrip = (event: FerryEvent): FerryEvent => {
    const page = newFrontmatter(serializeEvent(event));
    const yaml = page.split("---")[1];
    return parseEvent(load(yaml) as Record<string, unknown>);
};

const base = {
    title: "yeep",
    allDay: false as const,
    startTime: "12:30",
    endTime: "18:30",
    type: "single" as const,
    date: "2026-08-26",
    endDate: null,
};

describe("an event survives the trip through YAML", () => {
    it("keeps an override pointing at its master", () => {
        // The exact note VAULT_T's failed drags wrote. Unquoted, the link came
        // back as [["CALENDARS/..."]], the parse failed, and the note stopped
        // being an event — so nothing rendered and the master went on drawing
        // the occurrence the note was there to replace.
        const event = roundTrip({
            ...base,
            recurrenceId: "2026-08-28",
            recurringParent: "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
        });
        expect(event).toMatchObject({
            title: "yeep",
            date: "2026-08-26",
            recurrenceId: "2026-08-28",
            recurringParent: "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
        });
    });

    it("writes the link as a string, not a sequence YAML has to be rescued from", () => {
        // Sharper than the test above, which the tolerant reader would pass
        // even against the old writer. This one looks at the raw YAML value:
        // unquoted, `[[a/b]]` is a sequence nested in a sequence, and the
        // reader's tolerance is a courtesy to notes already on disk, not a
        // licence for the writer to go on emitting them.
        const page = newFrontmatter(
            serializeEvent({
                ...base,
                recurrenceId: "2026-08-28",
                recurringParent:
                    "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
            })
        );
        const raw = load(page.split("---")[1]) as Record<string, unknown>;
        expect(typeof raw.recurringParent).toBe("string");
        expect(raw.recurringParent).toBe(
            "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]"
        );
    });

    it("keeps a title containing a colon, and the keys below it", () => {
        // Unquoted this is not a wrong value but a syntax error, so every other
        // key in the note goes down with it.
        const event = roundTrip({ ...base, title: "Meeting: budget" });
        expect(event.title).toBe("Meeting: budget");
        expect(event).toMatchObject({ startTime: "12:30", date: "2026-08-26" });
    });

    it("keeps titles YAML would otherwise resolve to another type", () => {
        for (const title of ["2026", "true", "null", "#1 priority", "- dash"]) {
            expect(roundTrip({ ...base, title }).title).toBe(title);
        }
    });

    it("keeps a title carrying quotes and backslashes", () => {
        const title = 'a "b" \\ c';
        expect(roundTrip({ ...base, title }).title).toBe(title);
    });

    it("keeps dates and times as the strings the schema wants", () => {
        const event = roundTrip(base);
        expect(event).toMatchObject({
            date: "2026-08-26",
            startTime: "12:30",
            endTime: "18:30",
        });
    });

    it("keeps a rule, its weekdays and its skipped dates", () => {
        const event = roundTrip({
            title: "yeep",
            allDay: false,
            startTime: "12:00",
            endTime: "18:00",
            type: "recurring",
            recurring: {
                start: "2026-08-18",
                freq: "weekly",
                byDay: ["MO", "TU", "TH", "FR"],
                until: "2026-12-12",
            },
            skipDates: ["2026-09-01", "20260902"],
        });
        expect(event).toMatchObject({
            type: "recurring",
            recurring: {
                start: "2026-08-18",
                freq: "weekly",
                byDay: ["MO", "TU", "TH", "FR"],
                until: "2026-12-12",
            },
            // The second would be the number 20260902 unquoted, which is what
            // SkipDate's error message has always warned about.
            skipDates: ["2026-09-01", "20260902"],
        });
    });
});
