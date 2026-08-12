import { FerryEvent } from "../types";
import {
    basenameForEvent,
    basenameMatchesEvent,
    datePrefix,
    disambiguate,
    filenameForEvent,
    isFilenameDateFormat,
    slugifyTitle,
} from "./filenames";

const single = (fields: Partial<FerryEvent>): FerryEvent =>
    ({
        type: "single",
        title: "Test Event",
        allDay: true,
        date: "2025-11-21",
        endDate: null,
        ...fields,
    } as FerryEvent);

describe("slugifyTitle", () => {
    it.each([
        ["Games Night, Owens", "Games_Night_Owens"],
        ["NANA LIFT", "NANA_LIFT"],
        ["Dan's Engagement", "Dans_Engagement"],
        // Whitespace runs collapse to one underscore, whatever they are made of.
        ["Too   many\tspaces", "Too_many_spaces"],
        ["  leading and trailing  ", "leading_and_trailing"],
        // Windows-illegal characters.
        ['a\\b/c:d*e?f"g<h>i|j', "abcdefghij"],
        // Obsidian link syntax.
        ["Meeting #3 [[linked]] ^block", "Meeting_3_linked_block"],
        // Repeated underscores collapse whether written or produced.
        ["already__underscored", "already_underscored"],
        ["_wrapped_", "wrapped"],
        [".dotfile.", "dotfile"],
    ])("%p slugs to %p", (title, expected) => {
        expect(slugifyTitle(title)).toBe(expected);
    });

    it("preserves case rather than normalising it", () => {
        expect(slugifyTitle("MiXeD Case Title")).toBe("MiXeD_Case_Title");
    });

    it("falls back to untitled when nothing survives stripping", () => {
        expect(slugifyTitle("")).toBe("untitled");
        expect(slugifyTitle("   ")).toBe("untitled");
        expect(slugifyTitle("///???")).toBe("untitled");
        expect(slugifyTitle("...")).toBe("untitled");
    });

    it("never emits a path separator", () => {
        expect(slugifyTitle("nested/path/title")).not.toContain("/");
    });
});

describe("datePrefix", () => {
    it("defaults to yyyymmdd", () => {
        expect(datePrefix("2025-11-21")).toBe("20251121");
    });

    it.each([
        ["yyyymmdd", "20251121"],
        ["yyyy-mm-dd", "2025-11-21"],
        ["yyyy_mm_dd", "2025_11_21"],
        ["ddmmyyyy", "21112025"],
        ["mmddyyyy", "11212025"],
    ] as const)("renders %p as %p", (format, expected) => {
        expect(datePrefix("2025-11-21", format)).toBe(expected);
    });

    it.each([
        "",
        "not a date",
        "2025-11",
        "21-11-2025",
        "2025/11/21",
        "2025-11-21T10:00",
    ])("returns null for unusable date %p", (date) => {
        expect(datePrefix(date)).toBeNull();
    });
});

describe("isFilenameDateFormat", () => {
    it("accepts known formats and rejects anything else", () => {
        expect(isFilenameDateFormat("yyyymmdd")).toBe(true);
        expect(isFilenameDateFormat("YYYYMMDD")).toBe(false);
        expect(isFilenameDateFormat("")).toBe(false);
        expect(isFilenameDateFormat(undefined)).toBe(false);
        expect(isFilenameDateFormat(null)).toBe(false);
        expect(isFilenameDateFormat(7)).toBe(false);
    });
});

describe("basenameForEvent", () => {
    it("joins the date prefix and the slug with an underscore", () => {
        expect(basenameForEvent(single({ title: "Games Night, Owens" }))).toBe(
            "20251121_Games_Night_Owens"
        );
    });

    it("honours the configured date format", () => {
        expect(
            basenameForEvent(single({ title: "NANA LIFT" }), "yyyy-mm-dd")
        ).toBe("2025-11-21_NANA_LIFT");
    });

    it("adds the .md extension in filenameForEvent", () => {
        expect(filenameForEvent(single({ title: "NANA LIFT" }))).toBe(
            "20251121_NANA_LIFT.md"
        );
    });

    it("names a recurring master for its DTSTART", () => {
        const event = {
            type: "recurring",
            title: "Gym",
            allDay: true,
            daysOfWeek: ["T", "R"],
            startRecur: "2026-03-17",
        } as unknown as FerryEvent;
        expect(basenameForEvent(event)).toBe("20260317_Gym");
    });

    it("names an open-ended recurring master with no prefix", () => {
        // The edit UI allows a recurring event with no start date, so there is
        // no date to prefix with. Refusing to name it would block a flow that
        // currently works.
        const event = {
            type: "recurring",
            title: "Gym",
            allDay: true,
            daysOfWeek: ["T"],
        } as unknown as FerryEvent;
        expect(basenameForEvent(event)).toBe("Gym");
    });

    it("names an rrule event for its start date", () => {
        const event = {
            type: "rrule",
            title: "Standup",
            allDay: true,
            startDate: "2026-01-05",
            rrule: "FREQ=WEEKLY",
            skipDates: [],
        } as unknown as FerryEvent;
        expect(basenameForEvent(event)).toBe("20260105_Standup");
    });

    it("throws rather than filing a note under a date it could not read", () => {
        expect(() => basenameForEvent(single({ date: "the 21st" }))).toThrow(
            /unusable date/
        );
    });
});

describe("disambiguate", () => {
    it("leaves a free basename alone", () => {
        expect(disambiguate("20251121_Gym", () => false)).toBe("20251121_Gym");
    });

    it("assigns _2, _3 in order as names fill up", () => {
        const taken = new Set<string>();
        const isTaken = (name: string) => taken.has(name);
        const assign = () => {
            const name = disambiguate("20251121_Gym", isTaken);
            taken.add(name);
            return name;
        };
        expect(assign()).toBe("20251121_Gym");
        expect(assign()).toBe("20251121_Gym_2");
        expect(assign()).toBe("20251121_Gym_3");
    });

    it("skips past a suffix that is already occupied", () => {
        const taken = new Set(["20251121_Gym", "20251121_Gym_2"]);
        expect(disambiguate("20251121_Gym", (n) => taken.has(n))).toBe(
            "20251121_Gym_3"
        );
    });

    it("gives up rather than looping forever on a broken predicate", () => {
        expect(() => disambiguate("x", () => true)).toThrow(
            /Could not find a free filename/
        );
    });
});

describe("basenameMatchesEvent", () => {
    it("accepts an exact match", () => {
        expect(basenameMatchesEvent("20251121_Gym", "20251121_Gym")).toBe(true);
    });

    it("accepts a collision suffix as a name the plugin itself assigned", () => {
        // Without this the repair pass would rename _2 back to the unsuffixed
        // name on every load, fighting its own collision handling.
        expect(basenameMatchesEvent("20251121_Gym_2", "20251121_Gym")).toBe(
            true
        );
        expect(basenameMatchesEvent("20251121_Gym_17", "20251121_Gym")).toBe(
            true
        );
    });

    it("rejects a name that has drifted", () => {
        expect(basenameMatchesEvent("2025-11-21 Gym", "20251121_Gym")).toBe(
            false
        );
        expect(basenameMatchesEvent("20251122_Gym", "20251121_Gym")).toBe(
            false
        );
        expect(
            basenameMatchesEvent("20251121_Gymnastics", "20251121_Gym")
        ).toBe(false);
    });

    it("rejects a non-numeric suffix, which is a different title", () => {
        expect(basenameMatchesEvent("20251121_Gym_bag", "20251121_Gym")).toBe(
            false
        );
        expect(basenameMatchesEvent("20251121_Gym_", "20251121_Gym")).toBe(
            false
        );
    });
});
