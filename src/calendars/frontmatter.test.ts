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
