import { TFile } from "obsidian";

import { Calendar, EventResponse } from "../calendars/Calendar";
import {
    EditableCalendar,
    EditableEventResponse,
} from "../calendars/EditableCalendar";
import { CalendarInfo, EventLocation, FerryEvent } from "src/types";
import EventCache, {
    CacheEntry,
    CalendarInitializerMap,
    FerryEventSource,
} from "./EventCache";
import { EventPathLocation } from "./EventStore";

jest.mock("../types/schema", () => ({
    validateEvent: (e: any) => e,
    // The real predicate, not a stub: pairing overrides with their masters is
    // the thing under test in `overriddenOccurrences`, and a stub would decide
    // its answer for it.
    isOverride: (e: any) => e.type === "single" && e.recurrenceId !== undefined,
}));

const withCounter = <T>(f: (x: string) => T, label?: string) => {
    const counter = () => {
        let count = 0;
        return () => (label || "") + count++;
    };
    const c = counter();
    return () => f(c());
};

const mockEvent = withCounter(
    (title): FerryEvent => ({ title } as FerryEvent),
    "event"
);

class TestReadonlyCalendar extends Calendar {
    get name(): string {
        return "test";
    }
    private _id: string;
    events: FerryEvent[] = [];
    constructor(color: string, id: string, events: FerryEvent[]) {
        super(color);
        this._id = id;
        this.events = events;
    }
    get type(): "FOR_TEST_ONLY" {
        return "FOR_TEST_ONLY";
    }

    get identifier(): string {
        return this._id;
    }

    async getEvents(): Promise<EventResponse[]> {
        return this.events.map((event) => [event, null]);
    }
}

// For tests, we only want test calendars to
const initializerMap = (
    cb: (info: CalendarInfo) => Calendar | null
): CalendarInitializerMap => ({
    FOR_TEST_ONLY: cb,
    local: () => null,
    dailynote: () => null,
    derived: () => null,
    ical: () => null,
    caldav: () => null,
});

const extractEvents = (source: FerryEventSource): FerryEvent[] =>
    source.events.map(({ event }) => event);

async function assertFailed(func: () => Promise<any>, message: RegExp) {
    try {
        await func();
    } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toMatch(message);
        return;
    }
    expect(false).toBeTruthy();
}

describe("event cache with readonly calendar", () => {
    const makeCache = (events: FerryEvent[]) => {
        const cache = new EventCache(
            initializerMap((info) => {
                if (info.type !== "FOR_TEST_ONLY") {
                    return null;
                }
                return new TestReadonlyCalendar(
                    info.color,
                    info.id,
                    info.events || []
                );
            })
        );
        cache.reset([
            { type: "FOR_TEST_ONLY", color: "#000000", id: "test", events },
        ]);
        return cache;
    };

    it("populates a single event", async () => {
        const event = mockEvent();
        const cache = makeCache([event]);

        expect(cache.initialized).toBeFalsy();
        await cache.populate();
        expect(cache.initialized).toBeTruthy();

        const calId = "FOR_TEST_ONLY::test";
        const calendar = cache.getCalendarById(calId);
        expect(calendar).toBeTruthy();
        expect(calendar?.id).toBe(calId);
        const sources = cache.getAllEvents();
        expect(sources.length).toBe(1);
        expect(extractEvents(sources[0])).toEqual([event]);
        expect(sources[0].color).toEqual("#000000");
        expect(sources[0].editable).toBeFalsy();
    });

    it("populates multiple events", async () => {
        const event1 = mockEvent();
        const event2 = mockEvent();
        const event3 = mockEvent();
        const cache = makeCache([event1, event2, event3]);

        await cache.populate();

        const sources = cache.getAllEvents();
        expect(sources.length).toBe(1);
        expect(extractEvents(sources[0])).toEqual([event1, event2, event3]);
        expect(sources[0].color).toEqual("#000000");
        expect(sources[0].editable);
    });

    it("properly sorts events into separate calendars", async () => {
        const cache = makeCache([]);
        const events1 = [mockEvent()];
        const events2 = [mockEvent(), mockEvent()];
        cache.reset([
            {
                type: "FOR_TEST_ONLY",
                id: "cal1",
                color: "red",
                events: events1,
            },
            {
                type: "FOR_TEST_ONLY",
                id: "cal2",
                color: "blue",
                events: events2,
            },
        ]);
        await cache.populate();

        const sources = cache.getAllEvents();
        expect(sources.length).toBe(2);
        expect(extractEvents(sources[0])).toEqual(events1);
        expect(sources[0].color).toEqual("red");
        expect(sources[0].editable);
        expect(extractEvents(sources[1])).toEqual(events2);
        expect(sources[1].color).toEqual("blue");
        expect(sources[1].editable);
    });

    it.each([
        [
            "addEvent",
            async (cache: EventCache, id: string) =>
                await cache.addEvent("FOR_TEST_ONLY::test", mockEvent()),
        ],
        [
            "deleteEvent",
            async (cache: EventCache, id: string) =>
                await cache.deleteEvent(id),
        ],
        [
            "modifyEvent",
            async (cache: EventCache, id: string) =>
                await cache.updateEventWithId(id, mockEvent()),
        ],
    ])("does not allow editing via %p", async (_, f) => {
        const event = mockEvent();
        const cache = makeCache([event]);
        cache.init();
        await cache.populate();

        const sources = cache.getAllEvents();
        expect(sources.length).toBe(1);
        const eventId = sources[0].events[0].id;

        assertFailed(async () => await f(cache, eventId), /read-only/i);
    });
});

class TestEditable extends EditableCalendar {
    get name(): string {
        return "test";
    }
    private _directory: string;
    events: EditableEventResponse[];
    shouldContainPath = true;
    constructor(
        color: string,
        directory: string,
        events: EditableEventResponse[]
    ) {
        super(color);
        this._directory = directory;
        this.events = events;
    }
    get directory(): string {
        return this._directory;
    }

    containsPath(path: string): boolean {
        return this.shouldContainPath;
    }

    getEvents = jest.fn(async () => this.events);
    getEventsInFile = jest.fn();

    createEvent = jest.fn();

    // Links are `[[path]]` here and resolve back to whatever is between the
    // brackets, so a test can point an override at a master by writing the
    // master's path and nothing has to stand in for Obsidian's link resolution.
    linkTo = jest.fn((path: string) => `[[${path}]]`);
    resolveLink = jest.fn((link: string) => {
        const target = /^\[\[(.+)\]\]$/.exec(link);
        return target ? target[1] : null;
    });

    deleteEvent = jest.fn();
    move = jest.fn();
    modifyEvent = jest.fn();
    getNewLocation = jest.fn();

    get type(): "FOR_TEST_ONLY" {
        return "FOR_TEST_ONLY";
    }
    get identifier(): string {
        return this.directory;
    }
}

const mockFile = withCounter((path) => ({ path } as TFile), "file");
const mockLocation = (withLine = false) => ({
    file: mockFile(),
    lineNumber: withLine ? Math.floor(Math.random() * 100) : undefined,
});

const mockEventResponse = (): EditableEventResponse => [
    mockEvent(),
    mockLocation(),
];

const assertCacheContentCounts = (
    cache: EventCache,
    {
        calendars,
        files,
        events,
    }: { calendars: number; files: number; events: number }
) => {
    expect(cache._storeForTest.calendarCount).toBe(calendars);
    expect(cache._storeForTest.fileCount).toBe(files);
    expect(cache._storeForTest.eventCount).toBe(events);
};

describe("editable calendars", () => {
    const makeCache = (events: EditableEventResponse[]) => {
        const cache = new EventCache(
            initializerMap((info) => {
                if (info.type !== "FOR_TEST_ONLY") {
                    return null;
                }
                return new TestEditable(info.color, info.id, events);
            })
        );
        cache.reset([
            { type: "FOR_TEST_ONLY", id: "test", events: [], color: "black" },
        ]);
        return cache;
    };

    const getId = (id: string) => `FOR_TEST_ONLY::${id}`;

    const getCalendar = (cache: EventCache, id: string) => {
        const calendar = cache.getCalendarById(getId(id));
        expect(calendar).toBeTruthy();
        expect(calendar).toBeInstanceOf(TestEditable);
        return calendar as TestEditable;
    };

    it("populates a single event", async () => {
        const e1 = mockEventResponse();
        const cache = makeCache([e1]);

        await cache.populate();

        const calendar = getCalendar(cache, "test");

        const sources = cache.getAllEvents();

        expect((calendar as TestEditable).getEvents.mock.calls.length).toBe(1);
        expect(sources.length).toBe(1);

        expect(extractEvents(sources[0])).toEqual([e1[0]]);
        expect(sources[0].color).toEqual("black");
        expect(sources[0].editable).toBeTruthy();
    });

    describe("add events", () => {
        it("empty cache", async () => {
            const cache = makeCache([]);

            await cache.populate();

            const calendar = getCalendar(cache, "test");

            const event = mockEvent();
            const loc = mockLocation();
            calendar.createEvent.mockReturnValueOnce(
                new Promise((resolve) => resolve(loc))
            );
            expect(await cache.addEvent(getId("test"), event)).toBeTruthy();
            expect(calendar.createEvent.mock.calls.length).toBe(1);
            expect(calendar.createEvent.mock.calls[0]).toEqual([event]);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });
        });

        it("in the same file", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();

            const calendar = getCalendar(cache, "test");

            const event2 = mockEvent();
            const loc = { file: event[1].file, lineNumber: 102 };
            calendar.createEvent.mockReturnValueOnce(
                new Promise((resolve) => resolve(loc))
            );
            expect(await cache.addEvent(getId("test"), event2)).toBeTruthy();
            expect(calendar.createEvent.mock.calls.length).toBe(1);
            expect(calendar.createEvent.mock.calls[0]).toEqual([event2]);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 2,
            });
        });

        it("in a different file", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();

            const event2 = mockEvent();
            const loc = mockLocation();

            const calendar = getCalendar(cache, "test");
            calendar.createEvent.mockReturnValueOnce(
                new Promise((resolve) => resolve(loc))
            );
            expect(await cache.addEvent(getId("test"), event2)).toBeTruthy();
            expect(calendar.createEvent.mock.calls.length).toBe(1);
            expect(calendar.createEvent.mock.calls[0]).toEqual([event2]);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 2,
                events: 2,
            });
        });

        it("adding many events", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();

            const calendar = getCalendar(cache, "test");

            calendar.createEvent
                .mockReturnValueOnce(
                    new Promise((resolve) => resolve(mockLocation()))
                )
                .mockReturnValueOnce(
                    new Promise((resolve) => resolve(mockLocation()))
                )
                .mockReturnValueOnce(
                    new Promise((resolve) => resolve(mockLocation()))
                );

            expect(
                await cache.addEvent(getId("test"), mockEvent())
            ).toBeTruthy();
            expect(
                await cache.addEvent(getId("test"), mockEvent())
            ).toBeTruthy();
            expect(
                await cache.addEvent(getId("test"), mockEvent())
            ).toBeTruthy();

            expect(calendar.createEvent.mock.calls.length).toBe(3);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 4,
                events: 4,
            });
        });
    });
    const pathResult = (loc: EventLocation): EventPathLocation => ({
        path: loc.file.path,
        lineNumber: loc.lineNumber,
    });
    describe("delete events", () => {
        it("delete one", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });

            const sources = cache.getAllEvents();
            expect(sources.length).toBe(1);
            const id = sources[0].events[0].id;

            await cache.deleteEvent(id);

            const calendar = getCalendar(cache, "test");
            expect(calendar.deleteEvent.mock.calls.length).toBe(1);
            expect(calendar.deleteEvent.mock.calls[0]).toEqual([
                pathResult(event[1]),
            ]);

            assertCacheContentCounts(cache, {
                calendars: 0,
                files: 0,
                events: 0,
            });
        });

        it("delete non-existing event", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();
            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });

            expect(cache._storeForTest.calendarCount).toBe(1);
            expect(cache._storeForTest.fileCount).toBe(1);
            expect(cache._storeForTest.eventCount).toBe(1);

            assertFailed(
                () => cache.deleteEvent("unknown ID"),
                /not present in event store/
            );

            const calendar = getCalendar(cache, "test");
            expect(calendar.deleteEvent.mock.calls.length).toBe(0);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });
        });
    });

    describe("modify event", () => {
        const oldEvent = mockEventResponse();
        const newLoc = mockLocation();
        const newEvent = mockEvent();

        it.each([
            [
                "calendar moves event to a new file",
                newLoc,
                [
                    { file: oldEvent[1].file, numEvents: 0 },
                    { file: newLoc.file, numEvents: 1 },
                ],
            ],
            [
                "calendar keeps event in the same file, but moves it around",
                { file: oldEvent[1].file, lineNumber: newLoc.lineNumber },
                [
                    { file: oldEvent[1].file, numEvents: 1 },
                    { file: newLoc.file, numEvents: 0 },
                ],
            ],
        ])("%p", async (_, newLocation, fileDetails) => {
            const cache = makeCache([oldEvent]);

            await cache.populate();

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });

            const sources = cache.getAllEvents();
            expect(sources.length).toBe(1);
            const id = sources[0].events[0].id;

            const calendar = getCalendar(cache, "test");
            calendar.modifyEvent.mockReturnValueOnce(
                new Promise((resolve) => resolve(newLocation))
            );
            calendar.getNewLocation.mockReturnValueOnce(
                new Promise((resolve) => resolve(newLocation))
            );

            expect(
                cache._storeForTest.getEventsInFile(oldEvent[1].file).length
            ).toBe(1);

            await cache.updateEventWithId(id, newEvent);

            expect(calendar.modifyEvent.mock.calls.length).toBe(1);
            const [loc, evt, _callback] = calendar.modifyEvent.mock.calls[0];
            _callback(newLocation);
            expect([loc, evt]).toEqual([pathResult(oldEvent[1]), newEvent]);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });

            expect(cache._storeForTest.getEventById(id)).toEqual(newEvent);

            for (const { file, numEvents } of fileDetails) {
                expect(cache._storeForTest.getEventsInFile(file).length).toBe(
                    numEvents
                );
            }
        });

        it("modify non-existing event", async () => {
            const event = mockEventResponse();
            const cache = makeCache([event]);

            await cache.populate();

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });

            assertFailed(
                () => cache.updateEventWithId("unknown ID", mockEvent()),
                /not present in event store/
            );

            const sources = cache.getAllEvents();
            expect(sources.length).toBe(1);
            const id = sources[0].events[0].id;

            const calendar = getCalendar(cache, "test");
            expect(calendar.modifyEvent.mock.calls.length).toBe(0);
            expect(cache._storeForTest.getEventById(id)).toEqual(event[0]);

            assertCacheContentCounts(cache, {
                calendars: 1,
                files: 1,
                events: 1,
            });
        });
    });

    describe("filesystem update callback", () => {
        const callbackMock = jest.fn();
        const oldEvent = mockEventResponse();
        const newEvent = mockEventResponse();
        let cache: EventCache;
        beforeEach(() => {
            cache = makeCache([oldEvent]);
            cache.populate();
            callbackMock.mockClear();
            cache.on("update", callbackMock);
        });

        it.each([
            {
                test: "New event in a new file",
                eventsInFile: [newEvent],
                file: newEvent[1].file,
                counts: { files: 2, events: 2 },
                callback: { toRemoveLength: 0, eventsToAdd: [newEvent[0]] },
            },
            {
                test: "Changing events in an existing location",
                eventsInFile: [[newEvent[0], oldEvent[1]]],
                file: oldEvent[1].file,
                counts: { files: 1, events: 1 },
                callback: { toRemoveLength: 1, eventsToAdd: [newEvent[0]] },
            },
            {
                test: "No callback fired if event does not change.",
                eventsInFile: [oldEvent],
                file: oldEvent[1].file,
                counts: { files: 1, events: 1 },
                callback: null,
            },
        ])(
            "$test",
            async ({
                eventsInFile,
                file,
                counts: { files, events },
                callback,
            }) => {
                const calendar = getCalendar(cache, "test");

                assertCacheContentCounts(cache, {
                    calendars: 1,
                    files: 1,
                    events: 1,
                });

                calendar.getEventsInFile.mockReturnValue(
                    new Promise((resolve) => resolve(eventsInFile))
                );

                await cache.fileUpdated(file as TFile);

                assertCacheContentCounts(cache, {
                    calendars: 1,
                    files,
                    events,
                });

                if (callback) {
                    expect(callbackMock).toBeCalled();
                    const { toRemoveLength, eventsToAdd } = callback;
                    const callbackInvocation: {
                        toRemove: string[];
                        toAdd: CacheEntry[];
                    } = callbackMock.mock.calls[0][0];

                    expect(callbackInvocation.toAdd).toBeDefined();
                    expect(callbackInvocation.toRemove).toBeDefined();

                    expect(callbackInvocation.toRemove.length).toBe(
                        toRemoveLength
                    );
                    expect(callbackInvocation.toAdd.length).toBe(
                        eventsToAdd.length
                    );
                    expect(
                        callbackInvocation.toAdd.map((e) => e.event)
                    ).toEqual(eventsToAdd);
                } else {
                    expect(callbackMock.mock.calls.length).toBe(0);
                }
            }
        );
        it.todo("updates when events are the same but locations are different");
    });

    /**
     * Pairing an override with the master it replaces.
     *
     * The link is followed to a path and the path to whatever event is stored
     * there, so what these pin is the pairing, not link syntax — `TestEditable`
     * resolves `[[x]]` to `x` and nothing else.
     */
    describe("occurrences an override has taken over", () => {
        const MASTER_PATH = "test/_recurring/20260317_Gym.md";

        const master = {
            title: "Gym",
            type: "recurring",
            recurring: { start: "2026-03-17", freq: "weekly", byDay: ["TU"] },
        } as unknown as FerryEvent;

        const override = (
            recurrenceId: string,
            recurringParent = `[[${MASTER_PATH}]]`
        ) =>
            ({
                title: `Gym (${recurrenceId})`,
                type: "single",
                date: recurrenceId,
                recurrenceId,
                recurringParent,
            } as unknown as FerryEvent);

        const at = (path: string): EventLocation => ({
            file: { path } as TFile,
            lineNumber: undefined,
        });

        /** The master's ID, which is generated and so cannot be written down. */
        const masterId = (cache: EventCache) => {
            const found = cache
                .getAllEvents()
                .flatMap((source) => source.events)
                .find(({ event }) => event.type === "recurring");
            expect(found).toBeTruthy();
            return found!.id;
        };

        const populated = async (events: EditableEventResponse[]) => {
            const cache = makeCache(events);
            await cache.populate();
            return cache;
        };

        it("names the occurrence the override stands in for", async () => {
            const cache = await populated([
                [master, at(MASTER_PATH)],
                [override("2026-03-24"), at("test/20260324_Gym.md")],
            ]);

            expect([...cache.overriddenOccurrences()]).toEqual([
                [masterId(cache), ["2026-03-24"]],
            ]);
        });

        it("collects every override of the same series", async () => {
            const cache = await populated([
                [master, at(MASTER_PATH)],
                [override("2026-03-24"), at("test/20260324_Gym.md")],
                [override("2026-04-07"), at("test/20260407_Gym.md")],
            ]);

            expect(cache.overriddenOccurrences().get(masterId(cache))).toEqual([
                "2026-03-24",
                "2026-04-07",
            ]);
        });

        it("leaves a series nothing overrides out of the answer", async () => {
            const cache = await populated([[master, at(MASTER_PATH)]]);
            expect(cache.overriddenOccurrences().size).toBe(0);
        });

        it("ignores ordinary events, which replace nothing", async () => {
            const cache = await populated([
                [master, at(MASTER_PATH)],
                [mockEvent(), at("test/20260324_Something.md")],
            ]);
            expect(cache.overriddenOccurrences().size).toBe(0);
        });

        it("keeps the series intact when the parent link leads nowhere", async () => {
            // A broken link is a hand-editable field gone wrong, so the
            // occurrence stays on the calendar beside whatever replaced it —
            // visibly duplicated, rather than the series quietly losing a day.
            const warn = jest
                .spyOn(console, "warn")
                .mockImplementation(() => {});
            const cache = await populated([
                [master, at(MASTER_PATH)],
                [
                    override("2026-03-24", "not a link at all"),
                    at("test/20260324_Gym.md"),
                ],
            ]);

            expect(cache.overriddenOccurrences().size).toBe(0);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it("keeps it intact when the parent is not a series", async () => {
            const warn = jest
                .spyOn(console, "warn")
                .mockImplementation(() => {});
            const cache = await populated([
                [mockEvent(), at(MASTER_PATH)],
                [override("2026-03-24"), at("test/20260324_Gym.md")],
            ]);

            expect(cache.overriddenOccurrences().size).toBe(0);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });

    /**
     * Writing a per-instance edit: the two shapes an edited occurrence takes.
     *
     * What these pin is which files exist afterwards and what they say, since
     * both operations are several writes that have to happen together or not at
     * all. The transformations themselves are `recurrence_edit.test.ts`.
     */
    describe("editing one occurrence of a series", () => {
        const MASTER_PATH = "test/_recurring/20260317_Gym.md";

        const master = {
            title: "Gym",
            type: "recurring",
            recurring: { start: "2026-03-17", freq: "weekly", byDay: ["TU"] },
        } as unknown as FerryEvent;

        const edited = (overrides: Record<string, unknown> = {}) =>
            ({
                title: "Gym (late)",
                type: "single",
                date: "2026-03-24",
                startTime: "19:00",
                endTime: "20:00",
                ...overrides,
            } as unknown as FerryEvent);

        const at = (path: string): EventLocation => ({
            file: { path } as TFile,
            lineNumber: undefined,
        });

        /** A populated cache holding one series, and its ID. */
        const withSeries = async (event: FerryEvent = master) => {
            const cache = makeCache([[event, at(MASTER_PATH)]]);
            await cache.populate();
            const calendar = getCalendar(cache, "test");
            const masterId = cache.getAllEvents()[0].events[0].id;
            return { cache, calendar, masterId };
        };

        describe("this event only", () => {
            it("writes the edit as a note that says which occurrence it replaces", async () => {
                const { cache, calendar, masterId } = await withSeries();
                calendar.createEvent.mockResolvedValueOnce(
                    at("test/20260324_Gym_late.md")
                );

                await cache.createOverride(masterId, "2026-03-24", edited());

                expect(calendar.createEvent).toHaveBeenCalledWith({
                    ...edited(),
                    recurrenceId: "2026-03-24",
                    recurringParent: `[[${MASTER_PATH}]]`,
                });
            });

            it("leaves the master alone, which is where the record is not kept", async () => {
                const { cache, calendar, masterId } = await withSeries();
                calendar.createEvent.mockResolvedValueOnce(
                    at("test/20260324_Gym_late.md")
                );

                await cache.createOverride(masterId, "2026-03-24", edited());

                expect(calendar.modifyEvent).not.toHaveBeenCalled();
                expect(cache.getEventById(masterId)).toEqual(master);
            });

            it("redraws the master, whose occurrence has to stop being drawn", async () => {
                // The master has not changed, so nothing else would ask the
                // view to look at it again — and until it does, the replaced
                // occurrence and the note replacing it are both on the calendar.
                const { cache, calendar, masterId } = await withSeries();
                calendar.createEvent.mockResolvedValueOnce(
                    at("test/20260324_Gym_late.md")
                );
                const onUpdate = jest.fn();
                cache.on("update", onUpdate);

                await cache.createOverride(masterId, "2026-03-24", edited());

                const redrawn = onUpdate.mock.calls
                    .map(([payload]) => payload)
                    .filter((payload) => payload.type === "events")
                    .some(
                        ({ toRemove, toAdd }) =>
                            toRemove.includes(masterId) &&
                            toAdd.some(
                                (entry: CacheEntry) => entry.id === masterId
                            )
                    );
                expect(redrawn).toBe(true);
            });

            it("refuses an event that does not repeat", async () => {
                const { cache, masterId } = await withSeries(edited());
                await assertFailed(
                    () =>
                        cache.createOverride(masterId, "2026-03-24", edited()),
                    /not a recurring event/
                );
            });
        });

        describe("this and following", () => {
            it("caps the old series and starts a new one at the edit date", async () => {
                const { cache, calendar, masterId } = await withSeries();
                calendar.createEvent.mockResolvedValueOnce(
                    at("test/_recurring/20260324_Gym_late.md")
                );
                // A real calendar reports where the note ended up, which is
                // what puts the rewritten event back in the store.
                calendar.modifyEvent.mockImplementation(
                    async (_loc, _event, updateCacheWithLocation) =>
                        updateCacheWithLocation(at(MASTER_PATH))
                );

                await cache.splitSeriesAt(masterId, "2026-03-24", {
                    ...master,
                    title: "Gym (late)",
                } as FerryEvent);

                expect(cache.getEventById(masterId)).toMatchObject({
                    recurring: { until: "2026-03-23" },
                });
                expect(calendar.createEvent).toHaveBeenCalledWith(
                    expect.objectContaining({
                        title: "Gym (late)",
                        recurring: expect.objectContaining({
                            start: "2026-03-24",
                        }),
                    })
                );
            });

            it("replaces the series outright when the split is at its first occurrence", async () => {
                // Capping it would leave a rule that generates nothing, so
                // there is no first half to keep.
                const { cache, calendar, masterId } = await withSeries();
                calendar.createEvent.mockResolvedValueOnce(
                    at("test/_recurring/20260317_Gym_late.md")
                );

                await cache.splitSeriesAt(masterId, "2026-03-17", {
                    ...master,
                    title: "Gym (late)",
                } as FerryEvent);

                expect(calendar.deleteEvent).toHaveBeenCalled();
                expect(cache.getEventById(masterId)).toBeNull();
                expect(calendar.createEvent).toHaveBeenCalledWith(
                    expect.objectContaining({ title: "Gym (late)" })
                );
            });

            it("writes nothing when the edit is no longer a series", async () => {
                // An edit that dropped the rule cannot become the half that
                // follows, and finding that out after capping the original
                // would leave the series truncated and nothing continuing it.
                const { cache, calendar, masterId } = await withSeries();

                await assertFailed(
                    () => cache.splitSeriesAt(masterId, "2026-03-24", edited()),
                    /not a recurring event/
                );
                expect(calendar.modifyEvent).not.toHaveBeenCalled();
                expect(calendar.deleteEvent).not.toHaveBeenCalled();
                expect(calendar.createEvent).not.toHaveBeenCalled();
            });
        });
    });

    describe("make sure cache is populated before doing anything", () => {});
});
