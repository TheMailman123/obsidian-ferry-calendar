import { TFile } from "obsidian";

import { Calendar, EventResponse } from "../calendars/Calendar";
import {
    EditableCalendar,
    EditableEventResponse,
} from "../calendars/EditableCalendar";
import { ObsidianInterface } from "../ObsidianAdapter";
import { CalendarInfo, EventLocation, FerryEvent } from "../types";
import EventCache, { CalendarInitializerMap } from "./EventCache";
import IcsExporter from "./IcsExporter";

const EXPORT_FOLDER = "_export";

/**
 * A vault that remembers what was written and how often.
 *
 * Only the handful of methods the exporter touches are real. The counts are
 * the point: "nothing is written unless something changed" is a claim about
 * writes, so a test that only looked at final contents could not tell a
 * skipped write from a rewrite with identical text.
 */
class RecordingVault {
    files = new Map<string, string>();
    folders = new Set<string>();
    writes: string[] = [];

    getAbstractFileByPath(path: string) {
        return this.files.has(path) || this.folders.has(path)
            ? ({ path } as TFile)
            : null;
    }

    getFileByPath(path: string) {
        return this.files.has(path) ? ({ path } as TFile) : null;
    }

    async createFolder(path: string) {
        this.folders.add(path);
    }

    async create(path: string, contents: string) {
        this.files.set(path, contents);
        this.writes.push(path);
        return { path } as TFile;
    }

    async read(file: TFile) {
        return this.files.get(file.path) as string;
    }

    async rewrite(file: TFile, rewriteFunc: (contents: string) => string) {
        this.files.set(file.path, rewriteFunc(this.files.get(file.path) ?? ""));
        this.writes.push(file.path);
    }

    /** How many times a given path has been written, ever. */
    writeCount(path: string) {
        return this.writes.filter((written) => written === path).length;
    }

    asInterface() {
        return this as unknown as ObsidianInterface;
    }
}

/**
 * An editable calendar backed by an array, whose links are `[[path]]`.
 *
 * `modifyEvent` really calls back into the cache, unlike the double in
 * `EventCache.test.ts`: assigning a uid has to land in the store, or the
 * second export would assign another one and the test would pass for the
 * wrong reason.
 */
class TestEditable extends EditableCalendar {
    private _directory: string;
    private _name: string;
    events: EditableEventResponse[];

    constructor(
        color: string,
        directory: string,
        events: EditableEventResponse[],
        name?: string
    ) {
        super(color);
        this._directory = directory;
        this.events = events;
        this._name = name ?? directory;
    }

    get name(): string {
        return this._name;
    }
    get directory(): string {
        return this._directory;
    }
    get type(): "FOR_TEST_ONLY" {
        return "FOR_TEST_ONLY";
    }
    get identifier(): string {
        return this._directory;
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

    modifyEvent = jest.fn(
        async (
            location: { path: string },
            event: FerryEvent,
            updateCacheWithLocation: (loc: EventLocation) => void
        ) => {
            updateCacheWithLocation({
                file: { path: location.path } as TFile,
                lineNumber: undefined,
            });
        }
    );

    getEventsInFile = jest.fn();
    createEvent = jest.fn();
    deleteEvent = jest.fn();
    move = jest.fn();
    getNewLocation = jest.fn();
}

/** A read-only calendar, to prove it is never exported. */
class TestReadonly extends Calendar {
    private _id: string;
    constructor(color: string, id: string) {
        super(color);
        this._id = id;
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
        return [];
    }
}

const at = (path: string): EventLocation => ({
    file: { path } as TFile,
    lineNumber: undefined,
});

const single = (title: string, date: string): FerryEvent =>
    ({
        title,
        type: "single",
        date,
        allDay: true,
    } as unknown as FerryEvent);

const master = (title: string, start: string): FerryEvent =>
    ({
        title,
        type: "recurring",
        allDay: true,
        recurring: { start, freq: "weekly", byDay: ["TU"] },
    } as unknown as FerryEvent);

const override = (
    title: string,
    recurrenceId: string,
    masterPath: string
): FerryEvent =>
    ({
        title,
        type: "single",
        date: recurrenceId,
        allDay: true,
        recurrenceId,
        recurringParent: `[[${masterPath}]]`,
    } as unknown as FerryEvent);

/**
 * A cache holding the given calendars, and an exporter over it.
 *
 * @param calendars Each with the settings row it should be built from, so a
 * test can turn the export off for one calendar and on for another.
 */
async function harness(
    calendars: { calendar: Calendar; info: Partial<CalendarInfo> }[]
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

    const vault = new RecordingVault();
    const exporter = new IcsExporter(
        cache,
        vault.asInterface(),
        () => EXPORT_FOLDER
    );
    return { cache, vault, exporter };
}

/** The lines of a written file, with the always-changing stamps dropped. */
const linesOf = (vault: RecordingVault, path: string) =>
    (vault.files.get(path) ?? "")
        .split("\r\n")
        .filter((line) => line && !line.startsWith("DTSTAMP:"));

describe("which calendars are written", () => {
    it("exports a calendar that opted in", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [single("Standup", "2026-03-17"), at("work/a.md")],
                ]),
                info: { exportToICS: true, reminderMinutes: 15 },
            },
        ]);

        expect(await exporter.exportAll()).toEqual([
            `${EXPORT_FOLDER}/work.ics`,
        ]);
        expect(linesOf(vault, `${EXPORT_FOLDER}/work.ics`)).toContain(
            "SUMMARY:Standup"
        );
    });

    it("writes nothing for a calendar that did not opt in", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "private", [
                    [single("Therapy", "2026-03-17"), at("private/a.md")],
                ]),
                info: { exportToICS: false },
            },
        ]);

        expect(await exporter.exportAll()).toEqual([]);
        expect(vault.writes).toEqual([]);
    });

    it("treats a missing exportToICS as opted out", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [single("Standup", "2026-03-17"), at("work/a.md")],
                ]),
                info: {},
            },
        ]);

        expect(await exporter.exportAll()).toEqual([]);
        expect(vault.writes).toEqual([]);
    });

    it("skips a read-only calendar even when it is enabled", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestReadonly("#000", "derived"),
                info: { exportToICS: true },
            },
        ]);

        expect(await exporter.exportAll()).toEqual([]);
        expect(vault.writes).toEqual([]);
    });

    it("creates the export folder once, and only when there is something to put in it", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [single("Standup", "2026-03-17"), at("work/a.md")],
                ]),
                info: { exportToICS: true },
            },
        ]);

        await exporter.exportAll();
        expect(vault.folders.has(EXPORT_FOLDER)).toBe(true);
    });

    it("gives two calendars of the same name separate files", async () => {
        const { exporter } = await harness([
            {
                calendar: new TestEditable(
                    "#000",
                    "one",
                    [[single("A", "2026-03-17"), at("one/a.md")]],
                    "Shared"
                ),
                info: { exportToICS: true },
            },
            {
                calendar: new TestEditable(
                    "#000",
                    "two",
                    [[single("B", "2026-03-17"), at("two/b.md")]],
                    "Shared"
                ),
                info: { exportToICS: true },
            },
        ]);

        expect(await exporter.exportAll()).toEqual([
            `${EXPORT_FOLDER}/Shared.ics`,
            `${EXPORT_FOLDER}/Shared_2.ics`,
        ]);
    });
});

describe("nothing is written unless something changed", () => {
    const enabledWork = (events: EditableEventResponse[]) => [
        {
            calendar: new TestEditable("#000", "work", events),
            info: { exportToICS: true },
        },
    ];

    it("does not rewrite a file whose events have not changed", async () => {
        const { vault, exporter } = await harness(
            enabledWork([[single("Standup", "2026-03-17"), at("work/a.md")]])
        );
        const path = `${EXPORT_FOLDER}/work.ics`;

        expect(await exporter.exportAll()).toEqual([path]);
        expect(await exporter.exportAll()).toEqual([]);
        expect(await exporter.exportAll()).toEqual([]);
        expect(vault.writeCount(path)).toBe(1);
    });

    it("rewrites when an event actually changes", async () => {
        const stored = single("Standup", "2026-03-17");
        const { cache, vault, exporter } = await harness(
            enabledWork([[stored, at("work/a.md")]])
        );
        const path = `${EXPORT_FOLDER}/work.ics`;

        await exporter.exportAll();
        const eventId = cache
            .getAllEvents()
            .flatMap((source) => source.events)
            .map(({ id }) => id)[0];
        await cache.processEvent(eventId, (event) => ({
            ...event,
            title: "Standup (moved)",
        }));

        expect(await exporter.exportAll()).toEqual([path]);
        expect(vault.writeCount(path)).toBe(2);
        expect(linesOf(vault, path)).toContain("SUMMARY:Standup (moved)");
    });

    it("ignores a differing DTSTAMP, which changes on every run", async () => {
        const { vault, exporter } = await harness(
            enabledWork([[single("Standup", "2026-03-17"), at("work/a.md")]])
        );
        const path = `${EXPORT_FOLDER}/work.ics`;

        await exporter.exportAll();
        const before = vault.files.get(path) as string;
        expect(before).toMatch(/DTSTAMP:/);

        // Stand in for a file written a day ago: same events, older stamp.
        vault.files.set(
            path,
            before.replace(/DTSTAMP:\d{8}T\d{6}Z/g, "DTSTAMP:20200101T000000Z")
        );

        expect(await exporter.exportAll()).toEqual([]);
        expect(vault.writeCount(path)).toBe(1);
    });
});

describe("event identity", () => {
    const uidLines = (vault: RecordingVault, path: string) =>
        linesOf(vault, path).filter((line) => line.startsWith("UID:"));

    it("assigns a uid to an event that has none and stores it on the note", async () => {
        const { cache, vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [single("Standup", "2026-03-17"), at("work/a.md")],
                ]),
                info: { exportToICS: true },
            },
        ]);

        await exporter.exportAll();

        const stored = cache
            .getAllEvents()
            .flatMap((source) => source.events)
            .map(({ event }) => event)[0];
        expect(stored.uid).toMatch(/@ferry-calendar$/);
        expect(uidLines(vault, `${EXPORT_FOLDER}/work.ics`)).toEqual([
            `UID:${stored.uid}`,
        ]);
    });

    it("keeps the same uid across exports, so a subscriber updates rather than replaces", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [single("Standup", "2026-03-17"), at("work/a.md")],
                ]),
                info: { exportToICS: true },
            },
        ]);
        const path = `${EXPORT_FOLDER}/work.ics`;

        await exporter.exportAll();
        const first = uidLines(vault, path);
        await exporter.exportAll();

        expect(uidLines(vault, path)).toEqual(first);
        expect(vault.writeCount(path)).toBe(1);
    });

    it("leaves a uid that is already on the note alone", async () => {
        const existing = {
            ...single("Standup", "2026-03-17"),
            uid: "kept@ferry-calendar",
        } as FerryEvent;
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [existing, at("work/a.md")],
                ]),
                info: { exportToICS: true },
            },
        ]);

        await exporter.exportAll();
        expect(uidLines(vault, `${EXPORT_FOLDER}/work.ics`)).toEqual([
            "UID:kept@ferry-calendar",
        ]);
    });
});

describe("overrides", () => {
    const MASTER_PATH = "work/_recurring/20260317_Gym.md";

    it("emits an override under its master's uid, with a recurrence id", async () => {
        const { vault, exporter } = await harness([
            {
                calendar: new TestEditable("#000", "work", [
                    [master("Gym", "2026-03-17"), at(MASTER_PATH)],
                    [
                        override("Gym (late)", "2026-03-24", MASTER_PATH),
                        at("work/20260324_Gym.md"),
                    ],
                ]),
                info: { exportToICS: true },
            },
        ]);

        await exporter.exportAll();
        const lines = linesOf(vault, `${EXPORT_FOLDER}/work.ics`);

        const uids = lines.filter((line) => line.startsWith("UID:"));
        expect(uids).toHaveLength(2);
        expect(new Set(uids).size).toBe(1);
        expect(lines.some((line) => line.startsWith("RECURRENCE-ID"))).toBe(
            true
        );
    });

    it("leaves out an override whose master is not in the export", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { vault, exporter } = await harness([
                {
                    calendar: new TestEditable("#000", "work", [
                        [
                            override("Gym (late)", "2026-03-24", MASTER_PATH),
                            at("work/20260324_Gym.md"),
                        ],
                    ]),
                    info: { exportToICS: true },
                },
            ]);

            await exporter.exportAll();
            const lines = linesOf(vault, `${EXPORT_FOLDER}/work.ics`);

            expect(lines.filter((line) => line.startsWith("UID:"))).toEqual([]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("not in this export")
            );
        } finally {
            warn.mockRestore();
        }
    });
});
