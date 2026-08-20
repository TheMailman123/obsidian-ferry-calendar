import { formatTagList, parseTagList, tagsFrontmatter } from "./tags";

describe("parseTagList", () => {
    it("reads a comma-separated list with hashes", () => {
        expect(parseTagList("#INVISIBLE, #EVENT")).toEqual([
            "INVISIBLE",
            "EVENT",
        ]);
    });

    it("reads the same list without hashes", () => {
        expect(parseTagList("INVISIBLE, EVENT")).toEqual([
            "INVISIBLE",
            "EVENT",
        ]);
    });

    it("accepts spaces as separators", () => {
        // A tag cannot contain a space, so a space can only be a separator.
        expect(parseTagList("#INVISIBLE #EVENT")).toEqual([
            "INVISIBLE",
            "EVENT",
        ]);
    });

    it("reads a single tag", () => {
        expect(parseTagList("#INVISIBLE")).toEqual(["INVISIBLE"]);
    });

    it("keeps a nested tag whole", () => {
        expect(parseTagList("#calendar/event")).toEqual(["calendar/event"]);
    });

    it("is empty for an empty field", () => {
        expect(parseTagList("")).toEqual([]);
        expect(parseTagList("   ")).toEqual([]);
        expect(parseTagList(", ,")).toEqual([]);
        expect(parseTagList("#")).toEqual([]);
    });

    it("drops duplicates, however they were written", () => {
        expect(parseTagList("#INVISIBLE, INVISIBLE")).toEqual(["INVISIBLE"]);
    });
});

describe("formatTagList", () => {
    it("puts the hashes back", () => {
        expect(formatTagList(["INVISIBLE", "EVENT"])).toBe(
            "#INVISIBLE, #EVENT"
        );
    });

    it("is empty for no tags", () => {
        expect(formatTagList([])).toBe("");
    });

    it("round-trips what the user typed", () => {
        expect(parseTagList(formatTagList(["INVISIBLE"]))).toEqual([
            "INVISIBLE",
        ]);
    });
});

describe("tagsFrontmatter", () => {
    it("writes no key at all when nothing is configured", () => {
        // The default. A `tags:` line on every note in a vault that does not
        // use them would be noise the plugin was never asked for.
        expect(tagsFrontmatter([])).toEqual({});
        expect("tags" in tagsFrontmatter([])).toBe(false);
    });

    it("writes the configured tags", () => {
        expect(tagsFrontmatter(["INVISIBLE"])).toEqual({
            tags: ["INVISIBLE"],
        });
    });
});
