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
