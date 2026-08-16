import { TFile } from "obsidian";

import { ObsidianInterface } from "src/ObsidianAdapter";
import { MockApp, MockAppBuilder } from "../../test_helpers/AppBuilder";
import { FileBuilder } from "../../test_helpers/FileBuilder";
import DerivedCalendar from "./DerivedCalendar";
import { derivedMappingSchema } from "./parsing/derived";

/*
 * The mapping itself is covered in parsing/derived.test.ts. What is left to
 * test here is the calendar's own job: which files it reads, and that the
 * events it hands back carry the note they came from.
 *
 * Fixtures are synthetic and domain-neutral by design — the whole point of a
 * derived calendar is that the plugin does not know what the notes are for.
 */

const makeApp = (app: MockApp): ObsidianInterface => ({
    getAbstractFileByPath: (path) => app.vault.getAbstractFileByPath(path),
    getFileByPath(path: string): TFile | null {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? f : null;
    },
    getMetadata: (file) => app.metadataCache.getFileCache(file),
    waitForMetadata: (file) =>
        new Promise((resolve) =>
            resolve(app.metadataCache.getFileCache(file)!)
        ),
    read: (file) => app.vault.read(file),
    create: jest.fn(),
    createFolder: jest.fn(),
    rewrite: jest.fn(),
    rename: jest.fn(),
    delete: jest.fn(),
    process: jest.fn(),
});

const dirName = "RECORDS";
const color = "#BADA55";
const mapping = derivedMappingSchema.parse({ start: "DATE" });

const makeCalendar = (app: ObsidianInterface, recursive = false) =>
    new DerivedCalendar(
        app,
        color,
        "Records",
        dirName,
        recursive,
        derivedMappingSchema.parse({ start: "DATE", repeat: "yearly" })
    );

describe("identity", () => {
    const calendar = makeCalendar(makeApp(MockAppBuilder.make().done()));

    it("is identified by directory and name together", () => {
        // One folder can carry several mappings, each its own calendar, so the
        // directory alone cannot tell two of them apart.
        expect(calendar.id).toBe("derived::RECORDS::Records");
    });

    it("reports the display name, not the directory", () => {
        expect(calendar.name).toBe("Records");
    });
});

describe("containsPath", () => {
    const app = makeApp(MockAppBuilder.make().done());

    it("claims files directly inside its directory", () => {
        expect(makeCalendar(app).containsPath("RECORDS/one.md")).toBe(true);
    });

    it("does not claim a directory that merely shares a prefix", () => {
        // "RECORDS" must not swallow "RECORDS_ARCHIVE".
        expect(makeCalendar(app).containsPath("RECORDS_ARCHIVE/one.md")).toBe(
            false
        );
    });

    it("ignores subfolders unless it is recursive", () => {
        expect(
            makeCalendar(app, false).containsPath("RECORDS/sub/one.md")
        ).toBe(false);
        expect(makeCalendar(app, true).containsPath("RECORDS/sub/one.md")).toBe(
            true
        );
    });

    it("does not claim files outside its directory", () => {
        expect(makeCalendar(app, true).containsPath("OTHER/one.md")).toBe(
            false
        );
    });
});

describe("reading a folder", () => {
    const buildVault = () =>
        MockAppBuilder.make()
            .folder(
                new MockAppBuilder(dirName)
                    .file(
                        "Alpha.md",
                        new FileBuilder().frontmatter({ DATE: "1990-04-12" })
                    )
                    .file(
                        "Beta.md",
                        // The ghost-event regression, at the calendar level: an
                        // empty property must produce no event at all.
                        new FileBuilder().frontmatter({ DATE: null })
                    )
                    .file("Gamma.md", new FileBuilder().text("no frontmatter"))
                    .folder(
                        new MockAppBuilder("sub").file(
                            "Delta.md",
                            new FileBuilder().frontmatter({
                                DATE: "1985-11-02",
                            })
                        )
                    )
            )
            .done();

    it("maps only the notes the mapping can describe", async () => {
        const calendar = makeCalendar(makeApp(buildVault()));
        const events = await calendar.getEvents();

        expect(events.length).toBe(1);
        expect(events[0][0]).toMatchObject({
            title: "Alpha",
            type: "rrule",
            startDate: "1990-04-12",
            rrule: "FREQ=YEARLY",
        });
    });

    it("keeps the source note as the event's location", async () => {
        // This is what lets a click open the note the event came from.
        const calendar = makeCalendar(makeApp(buildVault()));
        const [[, location]] = await calendar.getEvents();
        expect(location?.file.path).toBe("RECORDS/Alpha.md");
    });

    it("skips subfolders unless recursive", async () => {
        const flat = await makeCalendar(
            makeApp(buildVault()),
            false
        ).getEvents();
        expect(flat.map(([e]) => e.title)).toEqual(["Alpha"]);

        const deep = await makeCalendar(
            makeApp(buildVault()),
            true
        ).getEvents();
        expect(deep.map(([e]) => e.title).sort()).toEqual(["Alpha", "Delta"]);
    });

    it("fails loudly when its directory is gone", async () => {
        const calendar = new DerivedCalendar(
            makeApp(buildVault()),
            color,
            "Records",
            "NOT_A_FOLDER",
            false,
            mapping
        );
        await expect(calendar.getEvents()).rejects.toThrow(/does not exist/);
    });
});

describe("reading a single file", () => {
    const app = makeApp(
        MockAppBuilder.make()
            .folder(
                new MockAppBuilder(dirName)
                    .file(
                        "Alpha.md",
                        new FileBuilder().frontmatter({ DATE: "1990-04-12" })
                    )
                    .file(
                        "Beta.md",
                        new FileBuilder().frontmatter({ DATE: null })
                    )
            )
            .done()
    );
    const calendar = makeCalendar(app);

    const fileAt = (path: string) => {
        const file = app.getFileByPath(path);
        if (!file) {
            throw new Error(`Fixture is missing ${path}`);
        }
        return file;
    };

    it("returns the note's event", async () => {
        const events = await calendar.getEventsInFile(
            fileAt("RECORDS/Alpha.md")
        );
        expect(events.length).toBe(1);
        expect(events[0][0].title).toBe("Alpha");
    });

    it("returns nothing for a note the mapping cannot describe", async () => {
        expect(
            await calendar.getEventsInFile(fileAt("RECORDS/Beta.md"))
        ).toEqual([]);
    });
});
