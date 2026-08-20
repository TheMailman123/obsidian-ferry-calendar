import { formatWikilink, parseWikilink, wikilinkFromYaml } from "./links";

describe("writing a wikilink", () => {
    it("drops the markdown extension", () => {
        expect(
            formatWikilink("CALENDARS/SOCIAL/_recurring/20260317_Gym.md")
        ).toBe("[[CALENDARS/SOCIAL/_recurring/20260317_Gym]]");
    });

    it("accepts a path that already has no extension", () => {
        expect(formatWikilink("CALENDARS/SOCIAL/_recurring/20260317_Gym")).toBe(
            "[[CALENDARS/SOCIAL/_recurring/20260317_Gym]]"
        );
    });

    it("writes the full path, not the basename", () => {
        // Two calendars can each hold a _recurring/20260317_Gym.md, and an
        // override is in neither master's folder, so the short form could
        // attach it to the wrong series.
        expect(
            formatWikilink("CALENDARS/WORK2/_recurring/20260317_Gym.md")
        ).toContain("WORK2");
    });

    it("leaves a .md inside a name alone", () => {
        expect(
            formatWikilink("CALENDARS/notes.md.backup/20260317_Gym.md")
        ).toBe("[[CALENDARS/notes.md.backup/20260317_Gym]]");
    });
});

describe("reading a wikilink", () => {
    it("reads the plain form the plugin writes", () => {
        expect(
            parseWikilink("[[CALENDARS/SOCIAL/_recurring/20260317_Gym]]")
        ).toBe("CALENDARS/SOCIAL/_recurring/20260317_Gym");
    });

    it("reads a bare basename, which Obsidian may shorten a link to", () => {
        expect(parseWikilink("[[20260317_Gym]]")).toBe("20260317_Gym");
    });

    it("drops an alias", () => {
        expect(parseWikilink("[[20260317_Gym|Gym]]")).toBe("20260317_Gym");
    });

    it("drops a heading reference", () => {
        expect(parseWikilink("[[20260317_Gym#Notes]]")).toBe("20260317_Gym");
    });

    it("drops a block reference", () => {
        expect(parseWikilink("[[20260317_Gym#^abc123]]")).toBe("20260317_Gym");
    });

    it("keeps a # that belongs to the alias rather than the target", () => {
        expect(parseWikilink("[[20260317_Gym|Gym #1]]")).toBe("20260317_Gym");
    });

    it("tolerates surrounding whitespace", () => {
        expect(parseWikilink("  [[20260317_Gym]]  ")).toBe("20260317_Gym");
    });

    it("answers null for a value that is not a link", () => {
        // The field is hand-editable, so this is a note to report on rather
        // than an error to fail the load with.
        expect(parseWikilink("20260317_Gym")).toBeNull();
        expect(parseWikilink("")).toBeNull();
        expect(parseWikilink("[[]]")).toBeNull();
        expect(parseWikilink("[[#heading]]")).toBeNull();
    });
});

describe("wikilinkFromYaml", () => {
    it("passes a properly quoted link straight through", () => {
        expect(
            wikilinkFromYaml("[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]")
        ).toBe("[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]");
    });

    it("recovers a link YAML read as a nested sequence", () => {
        // What Obsidian handed back for an unquoted `recurringParent`, and the
        // reason every override note written before PLANNING §13.2 was fixed
        // silently stopped being an event.
        expect(
            wikilinkFromYaml([["CALENDARS/SOCIAL/_recurring/20260818_yeep"]])
        ).toBe("[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]");
    });

    it("recovers a link carrying an alias", () => {
        expect(wikilinkFromYaml([["20260317_Gym|the gym"]])).toBe(
            "[[20260317_Gym|the gym]]"
        );
    });

    it("declines anything that is not one of the two shapes", () => {
        // An ordinary list of strings is somebody's own frontmatter, not a
        // mangled link, and guessing at it would be worse than rejecting it.
        expect(wikilinkFromYaml(["a", "b"])).toBeNull();
        expect(wikilinkFromYaml([["a"], ["b"]])).toBeNull();
        expect(wikilinkFromYaml([["a", "b"]])).toBeNull();
        expect(wikilinkFromYaml(42)).toBeNull();
        expect(wikilinkFromYaml(null)).toBeNull();
        expect(wikilinkFromYaml(undefined)).toBeNull();
    });
});
