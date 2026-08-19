import { DateTime, Settings } from "luxon";
import { TFile } from "obsidian";

import { Calendar, EventResponse } from "../calendars/Calendar";
import {
    EditableCalendar,
    EditableEventResponse,
} from "../calendars/EditableCalendar";
import { CalendarInfo, EventLocation, FerryEvent } from "../types";
import { parseEvent } from "../types/schema";
import EventCache, { CalendarInitializerMap } from "./EventCache";
import Notifier, { Reminder } from "./Notifier";

/**
 * Reminding you about an event while Obsidian is open.
 *
 * Pinned to Sydney for the reason `calendars/occurrences.test.ts` is: a
 * recurrence rule read in the wrong terms is a whole day out, and in UTC that
 * mistake is invisible. Every moment here is a wall-clock time in that zone,
 * and the clock is handed in rather than read, so the tests are about what is
 * due and never about when they happen to be run.
 */

const SYDNEY = "Australia/Sydney";

beforeAll(() => {
    Settings.defaultZone = SYDNEY;
});

afterAll(() => {
    Settings.defaultZone = "system";
});

const at = (iso: string) => DateTime.fromISO(iso, { zone: SYDNEY });

const event = (frontmatter: Record<string, unknown>): FerryEvent =>
    parseEvent(frontmatter) as FerryEvent;

const located = (path: string): EventLocation => ({
    file: { path } as TFile,
    lineNumber: undefined,
});

/** An editable calendar backed by an array, whose links are `[[path]]`. */
class TestEditable extends EditableCalendar {
    private _id: string;
    events: EditableEventResponse[];

    constructor(id: string, events: EditableEventResponse[]) {
        super("#000");
        this._id = id;
        this.events = events;
    }

    get name(): string {
        return this._id;
    }
    get directory(): string {
        return this._id;
    }
    get type(): "FOR_TEST_ONLY" {
        return "FOR_TEST_ONLY";
    }
    get identifier(): string {
        return this._id;
    }

    containsPath(): boolean {
        return true;
    }

    async getEvents() {
        return this.events;
    }

    linkTo = jest.fn((path: string) => `[[${path}]]`);
    resolveLink = jest.fn((link: string) => {
        const target = /^\[\[(.+)\]\]$/.exec(link);
        return target ? target[1] : null;
    });

    getEventsInFile = jest.fn();
    createEvent = jest.fn();
    deleteEvent = jest.fn();
    modifyEvent = jest.fn();
    move = jest.fn();
    getNewLocation = jest.fn();
}

/** A read-only calendar, to prove it never reminds. */
class TestReadonly extends Calendar {
    private _id: string;
    private _events: EventResponse[];

    constructor(id: string, events: EventResponse[]) {
        super("#000");
        this._id = id;
        this._events = events;
    }
    get name(): string {
        return this._id;
    }
    get type(): "FOR_TEST_ONLY" {
        return "FOR_TEST_ONLY";
    }
    get identifier(): string {
        return this._id;
    }
    async getEvents(): Promise<EventResponse[]> {
        return this._events;
    }
}

/**
 * A notifier over a cache holding the given calendars.
 *
 * @param calendars Each with the settings row it is built from, so a test can
 * give one calendar a lead time, another none, and see which speaks up.
 * @returns The notifier, the reminders it has shown, and a settable clock.
 */
async function harness(
    calendars: { calendar: Calendar; info: Partial<CalendarInfo> }[],
    options: { enabled?: boolean } = {}
) {
    const infos = calendars.map(
        ({ calendar, info }) =>
            ({
                type: "FOR_TEST_ONLY",
                id: calendar.identifier,
                ...info,
            } as unknown as CalendarInfo)
    );

    const byIdentifier = new Map(
        calendars.map(({ calendar }) => [calendar.identifier, calendar])
    );
    const initializers: CalendarInitializerMap = {
        FOR_TEST_ONLY: (info: CalendarInfo) =>
            byIdentifier.get((info as unknown as { id: string }).id) ?? null,
        local: () => null,
        dailynote: () => null,
        derived: () => null,
        ical: () => null,
        caldav: () => null,
    };

    const cache = new EventCache(initializers);
    cache.reset(infos);
    await cache.populate();

    const shown: Reminder[] = [];
    let now = at("2026-03-17T08:00");
    let enabled = options.enabled ?? true;

    const notifier = new Notifier(
        cache,
        (reminder) => shown.push(reminder),
        () => enabled,
        () => now
    );

    return {
        cache,
        notifier,
        shown,
        titlesShown: () => shown.map((r) => r.title),
        tickAt: (iso: string) => {
            now = at(iso);
            return notifier.check();
        },
        setEnabled: (value: boolean) => {
            enabled = value;
        },
    };
}

/** A calendar with one 9am standup on the 17th. */
const standupCalendar = () =>
    new TestEditable("work", [
        [
            event({
                title: "Standup",
                date: "2026-03-17",
                startTime: "09:00",
                endTime: "09:30",
            }),
            located("work/standup.md"),
        ],
    ]);

describe("when a reminder is shown", () => {
    it("shows nothing until the event is within the lead time", async () => {
        const h = await harness([
            {
                calendar: standupCalendar(),
                info: { reminderMinutes: 15 },
            },
        ]);

        expect(h.tickAt("2026-03-17T08:30")).toEqual([]);
        expect(h.tickAt("2026-03-17T08:44")).toEqual([]);
        expect(h.tickAt("2026-03-17T08:45").map((r) => r.title)).toEqual([
            "Standup",
        ]);
    });

    it("shows a reminder only once, however often it is asked", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 15 } },
        ]);

        h.tickAt("2026-03-17T08:50");
        h.tickAt("2026-03-17T08:51");
        h.tickAt("2026-03-17T08:59");

        expect(h.titlesShown()).toEqual(["Standup"]);
    });

    it("still catches an event whose moment fell between two ticks", async () => {
        const h = await harness([
            // No lead at all: the moment it falls due is the moment it starts,
            // which no tick lands on exactly.
            { calendar: standupCalendar(), info: { reminderMinutes: 0 } },
        ]);

        expect(h.tickAt("2026-03-17T08:59")).toEqual([]);
        expect(h.tickAt("2026-03-17T09:00:20").map((r) => r.title)).toEqual([
            "Standup",
        ]);
    });

    it("says nothing about an event that has already started", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-17T09:20")).toEqual([]);
    });

    it("says nothing about a trip that is already under way", async () => {
        const trip = new TestEditable("travel", [
            [
                event({
                    title: "Ferry",
                    date: "2026-03-16",
                    startTime: "18:00",
                    endTime: "23:00",
                }),
                located("travel/ferry.md"),
            ],
        ]);
        const h = await harness([
            { calendar: trip, info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-16T20:00")).toEqual([]);
    });

    it("shows nothing at all while notifications are switched off", async () => {
        const h = await harness(
            [{ calendar: standupCalendar(), info: { reminderMinutes: 15 } }],
            { enabled: false }
        );

        expect(h.tickAt("2026-03-17T08:50")).toEqual([]);

        // And picks the same event up as soon as it is switched back on.
        h.setEnabled(true);
        expect(h.tickAt("2026-03-17T08:51").map((r) => r.title)).toEqual([
            "Standup",
        ]);
    });
});

describe("which events remind", () => {
    it("leaves out a calendar with no reminder set", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: null } },
        ]);

        expect(h.tickAt("2026-03-17T08:50")).toEqual([]);
    });

    it("leaves out a read-only calendar", async () => {
        const readonly = new TestReadonly("holidays", [
            [
                event({
                    title: "Public holiday",
                    date: "2026-03-17",
                    startTime: "09:00",
                    endTime: "17:00",
                }),
                null,
            ],
        ]);
        const h = await harness([
            { calendar: readonly, info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-17T08:50")).toEqual([]);
    });

    it("leaves out an all-day event, which has no time to warn about", async () => {
        const allDay = new TestEditable("trips", [
            [
                event({
                    title: "Conference",
                    allDay: true,
                    date: "2026-03-18",
                }),
                located("trips/conference.md"),
            ],
        ]);
        const h = await harness([
            { calendar: allDay, info: { reminderMinutes: 15 } },
        ]);

        // 15 minutes before midnight on the 18th, which is when a lead time
        // taken literally would have gone off.
        expect(h.tickAt("2026-03-17T23:45")).toEqual([]);
    });

    it("gives each calendar its own lead time", async () => {
        const soon = new TestEditable("work", [
            [
                event({
                    title: "Standup",
                    date: "2026-03-17",
                    startTime: "09:00",
                    endTime: "09:30",
                }),
                located("work/standup.md"),
            ],
        ]);
        const early = new TestEditable("travel", [
            [
                event({
                    title: "Ferry",
                    date: "2026-03-17",
                    startTime: "09:00",
                    endTime: "10:00",
                }),
                located("travel/ferry.md"),
            ],
        ]);
        const h = await harness([
            { calendar: soon, info: { reminderMinutes: 5 } },
            { calendar: early, info: { reminderMinutes: 60 } },
        ]);

        expect(h.tickAt("2026-03-17T08:30").map((r) => r.title)).toEqual([
            "Ferry",
        ]);
        expect(h.tickAt("2026-03-17T08:56").map((r) => r.title)).toEqual([
            "Standup",
        ]);
    });
});

describe("series", () => {
    const gym = () =>
        new TestEditable("fitness", [
            [
                event({
                    title: "Gym",
                    type: "recurring",
                    startTime: "07:00",
                    endTime: "08:00",
                    recurring: { start: "2026-03-17", freq: "daily" },
                }),
                located("fitness/gym.md"),
            ],
        ]);

    it("reminds about each occurrence in turn", async () => {
        const h = await harness([
            { calendar: gym(), info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-17T06:50").map((r) => r.title)).toEqual([
            "Gym",
        ]);
        // The same series, a different day: a reminder already shown must not
        // silence tomorrow's.
        expect(h.tickAt("2026-03-18T06:50").map((r) => r.title)).toEqual([
            "Gym",
        ]);
        expect(h.titlesShown()).toEqual(["Gym", "Gym"]);
    });

    it("says nothing about an occurrence the series skips", async () => {
        const skipping = new TestEditable("fitness", [
            [
                event({
                    title: "Gym",
                    type: "recurring",
                    startTime: "07:00",
                    endTime: "08:00",
                    recurring: { start: "2026-03-17", freq: "daily" },
                    skipDates: ["2026-03-18"],
                }),
                located("fitness/gym.md"),
            ],
        ]);
        const h = await harness([
            { calendar: skipping, info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-18T06:50")).toEqual([]);
    });

    it("reminds about the override, not the occurrence it replaced", async () => {
        const overridden = new TestEditable("fitness", [
            [
                event({
                    title: "Gym",
                    type: "recurring",
                    startTime: "07:00",
                    endTime: "08:00",
                    recurring: { start: "2026-03-17", freq: "daily" },
                }),
                located("fitness/gym.md"),
            ],
            [
                event({
                    title: "Gym (late)",
                    date: "2026-03-18",
                    startTime: "09:00",
                    endTime: "10:00",
                    recurrenceId: "2026-03-18",
                    recurringParent: "[[fitness/gym.md]]",
                }),
                located("fitness/gym-late.md"),
            ],
        ]);
        const h = await harness([
            { calendar: overridden, info: { reminderMinutes: 15 } },
        ]);

        // The occurrence the override stands in for is cancelled, so 6:45 is
        // quiet even though the series says there is a 7am session.
        expect(h.tickAt("2026-03-18T06:45")).toEqual([]);
        expect(h.tickAt("2026-03-18T08:45").map((r) => r.title)).toEqual([
            "Gym (late)",
        ]);
    });
});

describe("what a reminder says", () => {
    it("counts down in minutes", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 15 } },
        ]);

        expect(h.tickAt("2026-03-17T08:45")[0].body).toBe(
            "In 15 minutes — 9:00 AM"
        );
    });

    it("says an event is starting rather than counting to zero", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 0 } },
        ]);

        expect(h.tickAt("2026-03-17T09:00:10")[0].body).toBe(
            "Starting now — 9:00 AM"
        );
    });

    it("carries the occurrence it is about", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 15 } },
        ]);

        const [reminder] = h.tickAt("2026-03-17T08:50");
        expect(reminder.occurrence.calendarId).toBeDefined();
        expect(reminder.occurrence.start.toISO()).toBe(
            at("2026-03-17T09:00").toISO()
        );
    });
});

describe("resetting", () => {
    it("forgets what it has shown, since event IDs are reused", async () => {
        const h = await harness([
            { calendar: standupCalendar(), info: { reminderMinutes: 15 } },
        ]);

        h.tickAt("2026-03-17T08:50");
        h.notifier.reset();
        h.tickAt("2026-03-17T08:51");

        expect(h.titlesShown()).toEqual(["Standup", "Standup"]);
    });
});
