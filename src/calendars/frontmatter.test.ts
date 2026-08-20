import { FerryEvent } from "../types";
import { modifyFrontmatterString, newFrontmatter } from "./frontmatter";

const event: Partial<FerryEvent> = {
    title: "Test Event",
    allDay: false,
    startTime: "11:00",
    endTime: "12:30",
    type: "single",
    date: "2022-01-01",
};

describe("newFrontmatter", () => {
    it("writes fields in the order they are given", () => {
        expect(newFrontmatter(event)).toBe(
            [
                "---",
                "title: Test Event",
                "allDay: false",
                "startTime: 11:00",
                "endTime: 12:30",
                "type: single",
                "date: 2022-01-01",
                "---",
                "",
            ].join("\n")
        );
    });

    it("omits undefined fields but writes null ones", () => {
        // `null` is how the schema spells "explicitly empty" — an event with no
        // end date — so it is a value to write, where undefined is a field the
        // event simply does not have.
        expect(
            newFrontmatter({
                title: "Test Event",
                endDate: null,
                endTime: undefined,
            })
        ).toBe(
            ["---", "title: Test Event", "endDate: null", "---", ""].join("\n")
        );
    });

    it("writes arrays inline", () => {
        expect(
            newFrontmatter({
                title: "Test Event",
                type: "recurring",
                daysOfWeek: ["M", "W"],
            })
        ).toBe(
            [
                "---",
                "title: Test Event",
                "type: recurring",
                "daysOfWeek: [M,W]",
                "---",
                "",
            ].join("\n")
        );
    });
});

describe("modifyFrontmatterString", () => {
    it("rewrites a field where it stands", () => {
        const page = newFrontmatter(event) + "\nSome note contents.\n";
        expect(modifyFrontmatterString(page, { endTime: "13:30" })).toBe(
            [
                "---",
                "title: Test Event",
                "allDay: false",
                "startTime: 11:00",
                "endTime: 13:30",
                "type: single",
                "date: 2022-01-01",
                "---",
                "",
                "Some note contents.",
                "",
            ].join("\n")
        );
    });

    it("leaves fields it was not asked to change alone", () => {
        // Frontmatter belongs to the note, not to the plugin: keys from other
        // plugins have to survive an edit untouched.
        const page = [
            "---",
            "title: Test Event",
            "tags: [personal,gym]",
            "date: 2022-01-01",
            "---",
            "",
        ].join("\n");
        expect(modifyFrontmatterString(page, { date: "2022-02-02" })).toBe(
            [
                "---",
                "title: Test Event",
                "tags: [personal,gym]",
                "date: 2022-02-02",
                "---",
                "",
            ].join("\n")
        );
    });

    it("appends fields the note did not already have", () => {
        const page = ["---", "title: Test Event", "---", ""].join("\n");
        expect(modifyFrontmatterString(page, { date: "2022-01-01" })).toBe(
            ["---", "title: Test Event", "date: 2022-01-01", "---", ""].join(
                "\n"
            )
        );
    });

    it("adds a frontmatter block to a note that has none", () => {
        expect(
            modifyFrontmatterString("Some note contents.\n", {
                title: "Test Event",
            })
        ).toBe(
            ["---", "title: Test Event", "---", "Some note contents.", ""].join(
                "\n"
            )
        );
    });

    it("ignores undefined modifications rather than deleting the field", () => {
        const page = ["---", "title: Test Event", "---", ""].join("\n");
        expect(modifyFrontmatterString(page, { title: undefined })).toBe(page);
    });
});

describe("nested blocks", () => {
    const recurring = {
        start: "2026-03-17",
        freq: "weekly",
        byDay: ["TU", "TH"],
        count: 10,
    };

    it("writes a block over as many lines as it has fields", () => {
        expect(newFrontmatter({ title: "Gym", recurring })).toBe(
            [
                "---",
                "title: Gym",
                "recurring:",
                "  start: 2026-03-17",
                "  freq: weekly",
                "  byDay: [TU,TH]",
                "  count: 10",
                "---",
                "",
            ].join("\n")
        );
    });

    it("omits undefined fields from within a block", () => {
        expect(
            newFrontmatter({
                recurring: {
                    start: "2026-03-17",
                    freq: "weekly",
                    until: undefined,
                },
            })
        ).toBe(
            [
                "---",
                "recurring:",
                "  start: 2026-03-17",
                "  freq: weekly",
                "---",
                "",
            ].join("\n")
        );
    });

    it("writes an empty block explicitly", () => {
        // A bare `recurring:` reads back as null, which the schema would then
        // have to tell apart from a block the user meant to leave empty.
        expect(newFrontmatter({ recurring: {} })).toBe(
            ["---", "recurring: {}", "---", ""].join("\n")
        );
    });

    it("leaves an authored block alone when something else changes", () => {
        // The whole point of authoring recurrence as a block is that the user
        // can read and edit it, so their spacing and their comments survive a
        // drag of the event that never touches the rule.
        const page = [
            "---",
            "title: Gym",
            "startTime: 06:30",
            "recurring:",
            "    start: 2026-03-17",
            "    freq: weekly",
            "    # every Tuesday and Thursday",
            "    byDay: [TU, TH]",
            "---",
            "",
        ].join("\n");
        expect(modifyFrontmatterString(page, { startTime: "07:00" })).toBe(
            [
                "---",
                "title: Gym",
                "startTime: 07:00",
                "recurring:",
                "    start: 2026-03-17",
                "    freq: weekly",
                "    # every Tuesday and Thursday",
                "    byDay: [TU, TH]",
                "---",
                "",
            ].join("\n")
        );
    });

    it("replaces a block whole, leaving none of the old lines behind", () => {
        const page = [
            "---",
            "title: Gym",
            "recurring:",
            "  start: 2026-03-17",
            "  freq: weekly",
            "  byDay: [TU,TH]",
            "  count: 10",
            "id: abc",
            "---",
            "",
        ].join("\n");
        expect(
            modifyFrontmatterString(page, {
                recurring: { start: "2026-03-17", freq: "daily" },
            })
        ).toBe(
            [
                "---",
                "title: Gym",
                "recurring:",
                "  start: 2026-03-17",
                "  freq: daily",
                "id: abc",
                "---",
                "",
            ].join("\n")
        );
    });

    it("appends a block to a note that had no recurrence", () => {
        const page = ["---", "title: Gym", "---", ""].join("\n");
        expect(modifyFrontmatterString(page, { recurring })).toBe(
            [
                "---",
                "title: Gym",
                "recurring:",
                "  start: 2026-03-17",
                "  freq: weekly",
                "  byDay: [TU,TH]",
                "  count: 10",
                "---",
                "",
            ].join("\n")
        );
    });

    it("round-trips a block it wrote itself", () => {
        const page = newFrontmatter({ title: "Gym", recurring });
        expect(modifyFrontmatterString(page, { title: "Gym" })).toBe(page);
    });

    it("keeps frontmatter lines it cannot read as fields", () => {
        // Dropping them silently is the failure mode worth avoiding: the note
        // is the user's, and a comment they wrote is not the plugin's to bin.
        const page = [
            "---",
            "# when the gym reopens",
            "title: Gym",
            "---",
            "",
        ].join("\n");
        expect(modifyFrontmatterString(page, { title: "Gym (moved)" })).toBe(
            [
                "---",
                "# when the gym reopens",
                "title: Gym (moved)",
                "---",
                "",
            ].join("\n")
        );
    });
});

describe("removing keys", () => {
    it("drops a key and leaves the rest in place", () => {
        const page = [
            "---",
            "title: Gym",
            "daysOfWeek: [T,R]",
            "startTime: 06:30",
            "---",
            "",
        ].join("\n");
        expect(modifyFrontmatterString(page, {}, ["daysOfWeek"])).toBe(
            ["---", "title: Gym", "startTime: 06:30", "---", ""].join("\n")
        );
    });

    it("drops a nested block along with its body", () => {
        const page = [
            "---",
            "title: Gym",
            "recurring:",
            "  start: 2026-03-17",
            "  freq: weekly",
            "id: abc",
            "---",
            "",
        ].join("\n");
        expect(modifyFrontmatterString(page, {}, ["recurring"])).toBe(
            ["---", "title: Gym", "id: abc", "---", ""].join("\n")
        );
    });

    it("rewrites one shape into another in a single pass", () => {
        // What upgrading an inherited event looks like: the authored block
        // arrives and the keys it replaces leave, so the note is never left
        // holding two descriptions of the same recurrence.
        const page = [
            "---",
            "title: Gym",
            "type: recurring",
            "daysOfWeek: [T,R]",
            "startRecur: 2026-03-17",
            "---",
            "",
        ].join("\n");
        expect(
            modifyFrontmatterString(
                page,
                {
                    recurring: {
                        start: "2026-03-17",
                        freq: "weekly",
                        byDay: ["TU", "TH"],
                    },
                },
                ["type", "daysOfWeek", "startRecur"]
            )
        ).toBe(
            [
                "---",
                "title: Gym",
                "recurring:",
                "  start: 2026-03-17",
                "  freq: weekly",
                "  byDay: [TU,TH]",
                "---",
                "",
            ].join("\n")
        );
    });

    it("ignores a key the note does not have", () => {
        const page = ["---", "title: Gym", "---", ""].join("\n");
        expect(modifyFrontmatterString(page, {}, ["daysOfWeek"])).toBe(page);
    });

    it("refuses to both write and remove the same key", () => {
        const page = ["---", "title: Gym", "---", ""].join("\n");
        expect(() =>
            modifyFrontmatterString(page, { title: "Gym" }, ["title"])
        ).toThrow("being both written and removed");
    });
});

describe("quoting values that YAML would not read back as strings", () => {
    // PLANNING §13.2. The writer emitted every string raw, which was survivable
    // while the plugin only wrote titles, dates and times, and stopped being
    // survivable the moment it wrote a wikilink.

    it("quotes a wikilink, which is otherwise a nested sequence", () => {
        expect(
            newFrontmatter({
                recurringParent:
                    "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
            })
        ).toBe(
            [
                "---",
                'recurringParent: "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]"',
                "---",
                "",
            ].join("\n")
        );
    });

    it("quotes a title containing a colon, which would break the whole block", () => {
        // Not one field: `title: Meeting: budget` is a YAML syntax error, so
        // every other key in the note goes with it.
        expect(newFrontmatter({ title: "Meeting: budget" })).toContain(
            'title: "Meeting: budget"'
        );
    });

    it("quotes values YAML resolves to a number, boolean or null", () => {
        const written = newFrontmatter({
            numeric: "2026",
            bool: "No",
            nothing: "null",
        });
        expect(written).toContain('numeric: "2026"');
        expect(written).toContain('bool: "No"');
        expect(written).toContain('nothing: "null"');
    });

    it("quotes a value opening with a comment or an indicator", () => {
        const written = newFrontmatter({
            hash: "#1 priority",
            dash: "- leading dash",
            trailing: "ends with colon:",
        });
        expect(written).toContain('hash: "#1 priority"');
        expect(written).toContain('dash: "- leading dash"');
        expect(written).toContain('trailing: "ends with colon:"');
    });

    it("escapes quotes and backslashes it has to write", () => {
        expect(newFrontmatter({ title: 'a "b" \\ c: d' })).toContain(
            'title: "a \\"b\\" \\\\ c: d"'
        );
    });

    it("quotes list elements that need it, in the flow context's terms", () => {
        // A comma or a bracket ends a scalar early inside `[...]` even though
        // it would be harmless on a line of its own.
        expect(
            newFrontmatter({ skipDates: ["2026-03-26", "20260402", "a,b"] })
        ).toContain('skipDates: [2026-03-26,"20260402","a,b"]');
    });

    it("leaves alone everything that already round-trips", () => {
        // The predicate is "would the bare form read back as this string", not
        // "might this be risky": quoting more would rewrite every note in the
        // vault on its next save for no correctness gain.
        expect(
            newFrontmatter({
                title: "Games Night, Owens",
                allDay: false,
                startTime: "11:00",
                date: "2022-01-01",
                endDate: null,
                completed: null,
                byDay: ["TU", "TH"],
                quoted: 'He said "hi"',
            })
        ).toBe(
            [
                "---",
                "title: Games Night, Owens",
                "allDay: false",
                "startTime: 11:00",
                "date: 2022-01-01",
                "endDate: null",
                "completed: null",
                "byDay: [TU,TH]",
                'quoted: He said "hi"',
                "---",
                "",
            ].join("\n")
        );
    });
});
