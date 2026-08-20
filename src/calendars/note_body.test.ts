import { readSection, upsertSection } from "./note_body";

/**
 * The plugin's first write into a note's *body* — PLANNING §13.6.
 *
 * The invariant under test throughout is the one `frontmatter.ts` holds for a
 * key: everything outside the section survives, in place and in order. A user's
 * note may hold anything, and none of it was put there by this plugin.
 */

describe("readSection", () => {
    it("reads the text under the heading", () => {
        expect(
            readSection("# DESCRIPTION\n\nDinner with Sam.\n", "DESCRIPTION")
        ).toBe("Dinner with Sam.");
    });

    it("stops at the next heading of the same level", () => {
        expect(
            readSection(
                "# DESCRIPTION\n\nDinner.\n\n# NOTES\n\nBring wine.\n",
                "DESCRIPTION"
            )
        ).toBe("Dinner.");
    });

    it("keeps a deeper heading inside the section", () => {
        expect(
            readSection(
                "# DESCRIPTION\n\nDinner.\n\n## Menu\n\nPasta.\n",
                "DESCRIPTION"
            )
        ).toBe("Dinner.\n\n## Menu\n\nPasta.");
    });

    it("reads a section that is not the first thing in the note", () => {
        expect(
            readSection(
                "Some notes.\n\n# DESCRIPTION\n\nDinner.\n",
                "DESCRIPTION"
            )
        ).toBe("Dinner.");
    });

    it("keeps paragraph breaks", () => {
        expect(
            readSection("# DESCRIPTION\n\nOne.\n\nTwo.\n", "DESCRIPTION")
        ).toBe("One.\n\nTwo.");
    });

    it("is null when the note has no such heading", () => {
        expect(readSection("Just a note.\n", "DESCRIPTION")).toBeNull();
        expect(readSection("", "DESCRIPTION")).toBeNull();
    });

    it("is empty rather than null for a heading with nothing under it", () => {
        // A different answer to "absent", and the two mean different things to
        // the caller.
        expect(readSection("# DESCRIPTION\n\n# NOTES\n", "DESCRIPTION")).toBe(
            ""
        );
    });

    it("ignores a heading inside a code fence", () => {
        // A note showing how to write markdown would otherwise cut its own
        // section short.
        const body =
            "# DESCRIPTION\n\nHow to:\n\n```\n# NOTES\n```\n\nThat is all.\n";
        expect(readSection(body, "DESCRIPTION")).toBe(
            "How to:\n\n```\n# NOTES\n```\n\nThat is all."
        );
    });

    it("does not match a heading whose text merely starts the same", () => {
        expect(
            readSection("# DESCRIPTIONS\n\nPlural.\n", "DESCRIPTION")
        ).toBeNull();
    });
});

describe("upsertSection, adding", () => {
    it("appends a section to a note that has none", () => {
        expect(upsertSection("Some notes.\n", "DESCRIPTION", "Dinner.")).toBe(
            "Some notes.\n\n# DESCRIPTION\n\nDinner.\n"
        );
    });

    it("writes into an empty body without a leading blank line", () => {
        expect(upsertSection("", "DESCRIPTION", "Dinner.")).toBe(
            "# DESCRIPTION\n\nDinner.\n"
        );
    });

    it("adds nothing when there is nothing to add", () => {
        expect(upsertSection("Some notes.\n", "DESCRIPTION", "")).toBe(
            "Some notes.\n"
        );
    });
});

describe("upsertSection, replacing", () => {
    it("replaces the contents where they stand", () => {
        expect(
            upsertSection(
                "# DESCRIPTION\n\nOld.\n\n# NOTES\n\nBring wine.\n",
                "DESCRIPTION",
                "New."
            )
        ).toBe("# DESCRIPTION\n\nNew.\n\n# NOTES\n\nBring wine.\n");
    });

    it("does not move a section that is not first", () => {
        expect(
            upsertSection(
                "Intro.\n\n# DESCRIPTION\n\nOld.\n\n# NOTES\n\nEnd.\n",
                "DESCRIPTION",
                "New."
            )
        ).toBe("Intro.\n\n# DESCRIPTION\n\nNew.\n\n# NOTES\n\nEnd.\n");
    });

    it("round-trips what it wrote", () => {
        const written = upsertSection(
            "Intro.\n",
            "DESCRIPTION",
            "One.\n\nTwo."
        );
        expect(readSection(written, "DESCRIPTION")).toBe("One.\n\nTwo.");
    });

    it("is stable when applied twice", () => {
        const once = upsertSection("Intro.\n", "DESCRIPTION", "Dinner.");
        expect(upsertSection(once, "DESCRIPTION", "Dinner.")).toBe(once);
    });
});

describe("upsertSection, removing", () => {
    it("removes the section and its heading", () => {
        expect(
            upsertSection(
                "Intro.\n\n# DESCRIPTION\n\nOld.\n\n# NOTES\n\nEnd.\n",
                "DESCRIPTION",
                ""
            )
        ).toBe("Intro.\n\n# NOTES\n\nEnd.\n");
    });

    it("removes a section that is the whole body", () => {
        expect(
            upsertSection("# DESCRIPTION\n\nOld.\n", "DESCRIPTION", "")
        ).toBe("");
    });

    it("leaves no growing gap when cleared repeatedly", () => {
        let body = "Intro.\n\n# DESCRIPTION\n\nOld.\n";
        body = upsertSection(body, "DESCRIPTION", "");
        const once = body;
        body = upsertSection(body, "DESCRIPTION", "");
        expect(body).toBe(once);
    });

    it("reads back as absent afterwards", () => {
        const cleared = upsertSection(
            "# DESCRIPTION\n\nOld.\n\n# NOTES\n\nEnd.\n",
            "DESCRIPTION",
            ""
        );
        expect(readSection(cleared, "DESCRIPTION")).toBeNull();
    });
});

describe("what upsertSection leaves alone", () => {
    it("keeps everything above and below, in order", () => {
        const body =
            "---not frontmatter---\n\nA line.\n\n# DESCRIPTION\n\nOld.\n\n## Sub\n\nUnder it.\n\n# NOTES\n\n- one\n- two\n";
        const written = upsertSection(body, "DESCRIPTION", "New.");
        expect(written).toContain("---not frontmatter---");
        expect(written).toContain("A line.");
        expect(written).toContain("# NOTES\n\n- one\n- two");
        // The `## Sub` was inside the section, so it goes with the contents.
        expect(written).not.toContain("## Sub");
    });

    it("does not treat a fenced heading as the end of the section", () => {
        const body =
            "# DESCRIPTION\n\nOld.\n\n# NOTES\n\n```\n# DESCRIPTION\n```\n";
        const written = upsertSection(body, "DESCRIPTION", "New.");
        expect(written).toBe(
            "# DESCRIPTION\n\nNew.\n\n# NOTES\n\n```\n# DESCRIPTION\n```\n"
        );
    });
});
