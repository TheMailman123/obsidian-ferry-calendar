import { join } from "path";
import { TFile } from "obsidian";

import { ObsidianInterface } from "src/ObsidianAdapter";
import { MockApp, MockAppBuilder } from "../../test_helpers/AppBuilder";
import { FileBuilder } from "../../test_helpers/FileBuilder";
import { FerryEvent } from "src/types";
import FullNoteCalendar from "./FullNoteCalendar";
import { parseEvent } from "../types/schema";
import { RECURRING_DIR } from "./filenames";

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
    createFolder: jest.fn(),
    rewrite: jest.fn(),
    rename: jest.fn(),
    delete: jest.fn(),
    process: jest.fn(),
    resolveLink: jest.fn(),
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

    describe("containsPath", () => {
        const calendar = new FullNoteCalendar(
            makeApp(MockAppBuilder.make().done()),
            color,
            "CALENDARS/WORK"
        );

        it("claims notes directly in its own folder", () => {
            expect(calendar.containsPath("CALENDARS/WORK/20220101_x.md")).toBe(
                true
            );
        });

        it("does not claim a sibling folder sharing its prefix", () => {
            // A bare startsWith made WORK claim every note under WORK2, and the
            // two calendars would then fight over the same files.
            expect(calendar.containsPath("CALENDARS/WORK2/20220101_x.md")).toBe(
                false
            );
        });

        it("claims recurring masters", () => {
            // The inversion of slice 3's rule, and the deliberate act of this
            // commit: getEvents() reads `_recurring/` now, so membership has to
            // agree or a master would be read on load and disowned on edit.
            expect(
                calendar.containsPath(
                    `CALENDARS/WORK/${RECURRING_DIR}/20260317_Gym.md`
                )
            ).toBe(true);
        });

        it("does not claim anything deeper than that", () => {
            expect(
                calendar.containsPath(
                    `CALENDARS/WORK/${RECURRING_DIR}/2026/20260317_Gym.md`
                )
            ).toBe(false);
        });

        it("does not claim other subfolders", () => {
            // A folder the user made is their arrangement of their vault.
            expect(
                calendar.containsPath("CALENDARS/WORK/archive/20220101_x.md")
            ).toBe(false);
        });

        it("does not claim notes outside it", () => {
            expect(calendar.containsPath("CALENDARS/20220101_x.md")).toBe(
                false
            );
            expect(calendar.containsPath("PEOPLE/someone.md")).toBe(false);
        });
    });

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
            date: 2022-01-01
            endDate: null
            ---
            "
        `);
    });
    it("reads recurrence masters out of _recurring/", async () => {
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder(dirName)
                        .file(
                            "20220101_Test_Event.md",
                            new FileBuilder().frontmatter({
                                title: "Test Event",
                                allDay: true,
                                date: "2022-01-01",
                            })
                        )
                        .folder(
                            new MockAppBuilder(RECURRING_DIR).file(
                                "20260317_Gym.md",
                                new FileBuilder().frontmatter({
                                    title: "Gym",
                                    allDay: true,
                                    recurring: {
                                        start: "2026-03-17",
                                        freq: "weekly",
                                        byDay: ["TU", "TH"],
                                    },
                                })
                            )
                        )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        const events = await calendar.getEvents();
        expect(events.map(([event]) => event.title).sort()).toEqual([
            "Gym",
            "Test Event",
        ]);

        // One event for the master, not one per occurrence: the rule is
        // expanded across the rendered range and nowhere else.
        const master = events.find(([event]) => event.title === "Gym");
        expect(master?.[0].type).toBe("recurring");
        expect(master?.[1].file.path).toBe(
            `${dirName}/${RECURRING_DIR}/20260317_Gym.md`
        );
    });

    it("plans repairs for masters as well as dated notes", async () => {
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder(dirName)
                        .file(
                            "2022-01-01 Test Event.md",
                            new FileBuilder().frontmatter({
                                title: "Test Event",
                                allDay: true,
                                date: "2022-01-01",
                            })
                        )
                        .folder(
                            new MockAppBuilder(RECURRING_DIR).file(
                                "Gym rule.md",
                                new FileBuilder().frontmatter({
                                    title: "Gym",
                                    allDay: true,
                                    recurring: {
                                        start: "2026-03-17",
                                        freq: "weekly",
                                    },
                                })
                            )
                        )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        const plan = await calendar.planFilenameRepair();
        expect(plan.renames).toEqual([
            {
                from: `${dirName}/2022-01-01 Test Event.md`,
                to: `${dirName}/20220101_Test_Event.md`,
            },
            {
                from: `${dirName}/${RECURRING_DIR}/Gym rule.md`,
                to: `${dirName}/${RECURRING_DIR}/20260317_Gym.md`,
            },
        ]);
    });

    it("writes a recurring event's rule as an authored block", async () => {
        const obsidian = makeApp(MockAppBuilder.make().done());
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, "20260317_Gym.md"),
        });

        await calendar.createEvent(
            parseEvent({
                title: "Gym",
                allDay: false,
                startTime: "06:30",
                endTime: "07:30",
                recurring: {
                    start: "2026-03-17",
                    freq: "weekly",
                    byDay: ["TU", "TH"],
                    count: 10,
                },
            })
        );

        const [path, contents] = (obsidian.create as jest.Mock).mock.calls[0];
        expect(path).toBe(`${dirName}/${RECURRING_DIR}/20260317_Gym.md`);
        expect(contents).toMatchInlineSnapshot(`
            "---
            title: Gym
            allDay: false
            startTime: 06:30
            endTime: 07:30
            recurring:
              start: 2026-03-17
              freq: weekly
              byDay: [TU,TH]
              count: 10
            ---
            "
        `);
    });

    it("files a new master in _recurring/, creating the folder", async () => {
        const obsidian = makeApp(
            MockAppBuilder.make().folder(new MockAppBuilder(dirName)).done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, RECURRING_DIR, "20260317_Gym.md"),
        });

        await calendar.createEvent(
            parseEvent({
                title: "Gym",
                allDay: true,
                recurring: { start: "2026-03-17", freq: "weekly" },
            })
        );

        expect(obsidian.createFolder).toHaveBeenCalledWith(
            `${dirName}/${RECURRING_DIR}`
        );
        expect((obsidian.create as jest.Mock).mock.calls[0][0]).toBe(
            `${dirName}/${RECURRING_DIR}/20260317_Gym.md`
        );
    });

    it("leaves a single event out of _recurring/", async () => {
        const obsidian = makeApp(
            MockAppBuilder.make().folder(new MockAppBuilder(dirName)).done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        (obsidian.create as jest.Mock).mockReturnValue({
            path: join(dirName, "20220101_Test_Event.md"),
        });

        await calendar.createEvent(
            parseEvent({
                title: "Test Event",
                allDay: true,
                date: "2022-01-01",
            })
        );

        // The folder is made when the first master needs it, not when a
        // calendar is configured.
        expect(obsidian.createFolder).not.toHaveBeenCalled();
        expect((obsidian.create as jest.Mock).mock.calls[0][0]).toBe(
            `${dirName}/20220101_Test_Event.md`
        );
    });

    it("moves a note into _recurring/ when its event becomes recurring", async () => {
        const filename = "20260317_Gym.md";
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder(dirName).file(
                        filename,
                        new FileBuilder().frontmatter({
                            title: "Gym",
                            allDay: true,
                            date: "2026-03-17",
                        })
                    )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        const event = parseEvent({
            title: "Gym",
            allDay: true,
            recurring: { start: "2026-03-17", freq: "weekly" },
        });
        const location = calendar.getNewLocation(
            { path: join(dirName, filename), lineNumber: undefined },
            event
        );
        expect(location.file.path).toBe(
            `${dirName}/${RECURRING_DIR}/${filename}`
        );

        await calendar.modifyEvent(
            { path: join(dirName, filename), lineNumber: undefined },
            event,
            jest.fn()
        );
        expect(obsidian.createFolder).toHaveBeenCalledWith(
            `${dirName}/${RECURRING_DIR}`
        );
        expect(obsidian.rename).toHaveBeenCalledWith(
            expect.anything(),
            `${dirName}/${RECURRING_DIR}/${filename}`
        );
    });

    it("moves a master back out when its event stops recurring", async () => {
        const filename = "20260317_Gym.md";
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder(dirName).folder(
                        new MockAppBuilder(RECURRING_DIR).file(
                            filename,
                            new FileBuilder().frontmatter({
                                title: "Gym",
                                allDay: true,
                                recurring: {
                                    start: "2026-03-17",
                                    freq: "weekly",
                                },
                            })
                        )
                    )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);

        const location = calendar.getNewLocation(
            {
                path: join(dirName, RECURRING_DIR, filename),
                lineNumber: undefined,
            },
            parseEvent({
                title: "Gym",
                allDay: true,
                date: "2026-03-17",
            })
        );
        expect(location.file.path).toBe(`${dirName}/${filename}`);
    });

    it("retires the inherited recurrence keys when it writes", async () => {
        // A note written by the original plugin, opened and then edited: the
        // rule it carries is upgraded on read, and saving it must leave one
        // description of the recurrence behind rather than two.
        const filename = "20260317_Gym.md";
        const obsidian = makeApp(
            MockAppBuilder.make()
                .folder(
                    new MockAppBuilder("events").file(
                        filename,
                        new FileBuilder().frontmatter({
                            title: "Gym",
                            allDay: true,
                            type: "recurring",
                            daysOfWeek: ["T", "R"],
                            startRecur: "2026-03-17",
                        })
                    )
                )
                .done()
        );
        const calendar = new FullNoteCalendar(obsidian, color, dirName);
        const file = obsidian.getAbstractFileByPath(
            join("events", filename)
        ) as TFile;
        const contents = await obsidian.read(file);

        const event = parseEvent({
            title: "Gym",
            allDay: true,
            type: "recurring",
            daysOfWeek: ["T", "R"],
            startRecur: "2026-03-17",
        });
        await calendar.modifyEvent(
            { path: join("events", filename), lineNumber: undefined },
            event,
            jest.fn()
        );

        const [, rewriteCallback] = (obsidian.rewrite as jest.Mock).mock
            .calls[0];
        expect(rewriteCallback(contents)).toMatchInlineSnapshot(`
            "---
            title: Gym
            allDay: true
            recurring:
              start: 2026-03-17
              freq: weekly
              byDay: [TU,TH]
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
