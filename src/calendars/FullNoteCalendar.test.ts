import { join } from "path";
import { TFile } from "obsidian";

import { ObsidianInterface } from "src/ObsidianAdapter";
import { MockApp, MockAppBuilder } from "../../test_helpers/AppBuilder";
import { FileBuilder } from "../../test_helpers/FileBuilder";
import { FerryEvent } from "src/types";
import FullNoteCalendar from "./FullNoteCalendar";
import { parseEvent } from "../types/schema";

const makeApp = (app: MockApp): ObsidianInterface => ({
    getAbstractFileByPath: (path) => app.vault.getAbstractFileByPath(path),
    getFileByPath(path: string): TFile | null {
        const f = app.vault.getAbstractFileByPath(path);
        if (!f) {
            return null;
        }
        if (!(f instanceof TFile)) {
            return null;
        }
        return f;
    },
    getMetadata: (file) => app.metadataCache.getFileCache(file),
    waitForMetadata: (file) =>
        new Promise((resolve) =>
            resolve(app.metadataCache.getFileCache(file)!)
        ),
    read: (file) => app.vault.read(file),
    create: jest.fn(),
    rewrite: jest.fn(),
    rename: jest.fn(),
    delete: jest.fn(),
    process: jest.fn(),
});

const dirName = "events";
const color = "#BADA55";

describe("Note Calendar Tests", () => {
    it.each([
        [
            "One event",
            [
                {
                    title: "20220101_Test_Event.md",
                    event: {
                        title: "Test Event",
                        allDay: true,
                        date: "2022-01-01",
                    } as FerryEvent,
                },
            ],
        ],
        [
            "Two events",
            [
                {
                    title: "20220101_Test_Event.md",
                    event: {
                        title: "Test Event",
                        allDay: true,
                        date: "2022-01-01",
                    } as FerryEvent,
                },
                {
                    title: "20220102_Another_Test_Event.md",
                    event: {
                        title: "Another Test Event",
                        allDay: true,
                        date: "2022-01-02",
                    } as FerryEvent,
                },
            ],
        ],
        [
            "Two events on the same day",
            [
                {
                    title: "20220101_Test_Event.md",
                    event: {
                        title: "Test Event",
                        allDay: true,
                        date: "2022-01-01",
                    } as FerryEvent,
                },
                {
                    title: "20220101_Another_Test_Event.md",
                    event: {
                        title: "Another Test Event",
                        date: "2022-01-01",
                        startTime: "11:00",
                        endTime: "12:00",
                    } as FerryEvent,
                },
            ],
        ],
    ])(
        "%p",
        async (_, inputs: { title: string; event: Partial<FerryEvent> }[]) => {
            const obsidian = makeApp(
                MockAppBuilder.make()
                    .folder(
                        inputs.reduce(
                            (builder, { title, event }) =>
                                builder.file(
                                    title,
                                    new FileBuilder().frontmatter(event)
                                ),
                            new MockAppBuilder(dirName)
                        )
                    )
                    .done()
            );
            const calendar = new FullNoteCalendar(obsidian, color, dirName);
            const res = await calendar.getEvents();
            expect(res.length).toBe(inputs.length);
            const events = res.map((e) => e[0]);
            const paths = res.map((e) => e[1].file.path);

            expect(
                res.every((elt) => elt[1].lineNumber === undefined)
            ).toBeTruthy();

            for (const { event, title } of inputs.map((i) => ({
                title: i.title,
                event: {
                    endDate: null,
                    allDay: false,
                    type: "single",
                    ...i.event,
                },
            }))) {
                expect(events).toContainEqual(event);
                expect(paths).toContainEqual(`${dirName}/${title}`);
            }

            for (const [
                event,
                {
                    file: { path },
                },
            ] of res) {
                const file = obsidian.getFileByPath(path)!;
                const eventsFromFile = await calendar.getEventsInFile(file);
                expect(eventsFromFile.length).toBe(1);
                expect(eventsFromFile[0][0]).toEqual(event);
            }
        }
    );
    it.todo("Recursive folder settings");

    it("creates an event", async () => {
        const obsidian = makeApp(MockAppBuilder.make().done());
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        const event = {
            title: "Test Event",
            date: "2022-01-01",
            endDate: null,
            allDay: false,
            startTime: "11:00",
            endTime: "12:30",
        };

        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, "20220101_Test_Event.md"),
        });
        const { lineNumber } = await calendar.createEvent(parseEvent(event));
        expect(lineNumber).toBeUndefined();
        expect(obsidian.create).toHaveBeenCalledTimes(1);
        const returns = (obsidian.create as jest.Mock).mock.calls[0];
        expect(returns).toMatchInlineSnapshot(`
            [
              "events/20220101_Test_Event.md",
              "---
            title: Test Event
            allDay: false
            startTime: 11:00
            endTime: 12:30
            type: single
            date: 2022-01-01
            endDate: null
            ---
            ",
            ]
        `);
    });

    it("creates an event under the configured date format", async () => {
        const obsidian = makeApp(MockAppBuilder.make().done());
        const calendar = new FullNoteCalendar(
            obsidian,
            color,
            dirName,
            "yyyy-mm-dd"
        );
        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, "2022-01-01_Test_Event.md"),
        });
        await calendar.createEvent(
            parseEvent({
                title: "Test Event",
                allDay: true,
                date: "2022-01-01",
                endDate: null,
            })
        );
        expect((obsidian.create as jest.Mock).mock.calls[0][0]).toBe(
            "events/2022-01-01_Test_Event.md"
        );
    });

    it("suffixes a colliding event rather than refusing it", async () => {
        // Two events on the same day with the same title are legitimate. The
        // old behaviour threw here, which made the second one uncreatable.
        const event = {
            title: "Test Event",
            allDay: true,
            date: "2022-01-01",
            endDate: null,
        };
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder("events")
                        .file(
                            "20220101_Test_Event.md",
                            new FileBuilder().frontmatter(event)
                        )
                        .file(
                            "20220101_Test_Event_2.md",
                            new FileBuilder().frontmatter(event)
                        )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, "20220101_Test_Event_3.md"),
        });
        await calendar.createEvent(parseEvent(event));
        expect((obsidian.create as jest.Mock).mock.calls[0][0]).toBe(
            "events/20220101_Test_Event_3.md"
        );
    });

    it("modify an existing event and keeping the same day and title", async () => {
        const event = parseEvent({
            title: "Test Event",
            allDay: false,
            date: "2022-01-01",
            endDate: null,
            startTime: "11:00",
            endTime: "12:30",
        });
        const filename = "20220101_Test_Event.md";
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder("events").file(
                        filename,
                        new FileBuilder().frontmatter(event)
                    )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        const firstFile = obsidian.getAbstractFileByPath(
            join("events", filename)
        ) as TFile;

        const contents = await obsidian.read(firstFile);

        const mockFn = jest.fn();
        await calendar.modifyEvent(
            { path: join("events", filename), lineNumber: undefined },
            // @ts-ignore
            { ...event, endTime: "13:30" },
            mockFn
        );
        // TODO: make the third param a mock that we can inspect
        const newLoc = mockFn.mock.calls[0][0];
        expect(newLoc.file.path).toBe(join("events", filename));
        expect(newLoc.lineNumber).toBeUndefined();

        expect(obsidian.rewrite).toHaveReturnedTimes(1);
        const [file, rewriteCallback] = (obsidian.rewrite as jest.Mock).mock
            .calls[0];
        expect(file.path).toBe(join("events", filename));

        expect(rewriteCallback(contents)).toMatchInlineSnapshot(`
            "---
            title: Test Event
            allDay: false
            startTime: 11:00
            endTime: 13:30
            type: single
            date: 2022-01-01
            endDate: null
            ---
            "
        `);
    });
    const modifyFixture = (filename: string) => {
        const event = parseEvent({
            title: "Test Event",
            allDay: false,
            date: "2022-01-01",
            endDate: null,
            startTime: "11:00",
            endTime: "12:30",
        });
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder("events").file(
                        filename,
                        new FileBuilder().frontmatter(event)
                    )
                )
                .done()
        );
        return {
            event,
            obsidian,
            calendar: new FullNoteCalendar(obsidian, color, dirName),
            location: {
                path: join("events", filename),
                lineNumber: undefined,
            },
        };
    };

    it("renames the note when the date changes", async () => {
        const { event, obsidian, calendar, location } = modifyFixture(
            "20220101_Test_Event.md"
        );
        const mockFn = jest.fn();

        await calendar.modifyEvent(
            location,
            parseEvent({ ...event, date: "2022-01-02" }),
            mockFn
        );

        const newPath = join("events", "20220102_Test_Event.md");
        expect(mockFn.mock.calls[0][0].file.path).toBe(newPath);
        expect(obsidian.rename).toHaveBeenCalledTimes(1);
        const [renamed, renamedTo] = (obsidian.rename as jest.Mock).mock
            .calls[0];
        expect(renamed.path).toBe(location.path);
        expect(renamedTo).toBe(newPath);
    });

    it("renames the note when the title changes", async () => {
        const { event, obsidian, calendar, location } = modifyFixture(
            "20220101_Test_Event.md"
        );

        await calendar.modifyEvent(
            location,
            parseEvent({ ...event, title: "Games Night, Owens" }),
            jest.fn()
        );

        expect((obsidian.rename as jest.Mock).mock.calls[0][1]).toBe(
            join("events", "20220101_Games_Night_Owens.md")
        );
    });

    it("keeps a collision suffix that the plugin assigned", async () => {
        // Renaming _2 back to the unsuffixed name would collide with the note
        // already holding it, and would undo the plugin's own disambiguation.
        const { event, obsidian, calendar, location } = modifyFixture(
            "20220101_Test_Event_2.md"
        );

        await calendar.modifyEvent(
            location,
            parseEvent({ ...event, endTime: "13:30" }),
            jest.fn()
        );

        expect(obsidian.rename).not.toHaveBeenCalled();
    });

    it("suffixes a rename that would collide with another note", async () => {
        const other = parseEvent({
            title: "Test Event",
            allDay: true,
            date: "2022-01-02",
            endDate: null,
        });
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder("events")
                        .file(
                            "20220101_Test_Event.md",
                            new FileBuilder().frontmatter({})
                        )
                        .file(
                            "20220102_Test_Event.md",
                            new FileBuilder().frontmatter(other)
                        )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        await calendar.modifyEvent(
            {
                path: join("events", "20220101_Test_Event.md"),
                lineNumber: undefined,
            },
            other,
            jest.fn()
        );

        expect((obsidian.rename as jest.Mock).mock.calls[0][1]).toBe(
            join("events", "20220102_Test_Event_2.md")
        );
    });
});
