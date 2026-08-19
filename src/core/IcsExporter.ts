import { ObsidianInterface } from "../ObsidianAdapter";
import { ExportEntry, exportToIcs } from "../calendars/ics_export";
import { disambiguate, slugifyTitle } from "../calendars/filenames";
import { EditableCalendar } from "../calendars/EditableCalendar";
import { FerryEvent, isOverride } from "../types/schema";
import EventCache from "./EventCache";

/**
 * Writing each exported calendar out as an `.ics` file.
 *
 * The last link the plugin owns in the chain PLANNING §7.4 measured: the file
 * written here is what a subscriber on the phone reads, and the phone is what
 * gives you the notification. Everything downstream of this file — carrying it,
 * re-reading it, raising the alert — belongs to Syncthing, ICSx⁵ and Android.
 *
 * `ics_export.ts` decides what the file *says*; this decides which events go in
 * it, what identity they carry, and whether it is worth writing at all.
 *
 * ## Nothing is written unless something changed
 *
 * The naive version stamps every event with the current time, so every export
 * differs from the last even when no event did — which would have Syncthing
 * re-transferring and ICSx⁵ re-syncing on a timer, forever. So the file is
 * generated, compared against what is already on disk with timestamps ignored,
 * and written only if it actually differs.
 *
 * That also settles a problem this would otherwise have: the plugin runs on
 * mobile too, so two devices can be exporting the same calendar into the same
 * synced folder. Both generate identical content, so the second one writes
 * nothing, and there is no conflict for Syncthing to raise.
 *
 * It is also what stops the export feeding itself. Assigning a `uid` rewrites a
 * note, which updates the cache, which triggers an export — but that export
 * finds every uid already present, produces identical content, and stops.
 */

/** Extension and folder are ours to choose; the name comes from the calendar. */
const ICS_SUFFIX = ".ics";

/**
 * A `uid` for an event that has never been exported.
 *
 * Random rather than derived. Anything derived from the event — title, date,
 * path — changes when the event does, and a uid that changes is worse than no
 * uid at all: the phone deletes the event and adds a new one rather than
 * updating it, losing whatever state the calendar had against it.
 */
function newUid(): string {
    return `${crypto.randomUUID()}@ferry-calendar`;
}

/**
 * Compare two exports ignoring the timestamps that always differ.
 *
 * `DTSTAMP` is required by RFC 5545 and names when the description of the event
 * was created, not when the event changed — so it differs on every run and says
 * nothing about whether anything happened. Comparing without it is what makes
 * "has this calendar changed?" answerable.
 */
function sameIgnoringStamps(a: string, b: string): boolean {
    const strip = (text: string) =>
        text
            .split("\r\n")
            .filter((line) => !line.startsWith("DTSTAMP:"))
            .join("\r\n");
    return strip(a) === strip(b);
}

export default class IcsExporter {
    private cache: EventCache;
    private vault: ObsidianInterface;
    private folder: () => string;

    /**
     * @param cache The event cache, which owns every write to a note — the uid
     * assignment goes through it rather than around it, so the store and the
     * view see the change like any other edit.
     * @param vault For writing the export itself, which is not a note and does
     * not belong to any calendar.
     * @param folder Where the files go, read at export time rather than
     * captured, since the setting can change while the plugin is running.
     */
    constructor(
        cache: EventCache,
        vault: ObsidianInterface,
        folder: () => string
    ) {
        this.cache = cache;
        this.vault = vault;
        this.folder = folder;
    }

    /**
     * Write every enabled calendar out, and answer which files changed.
     *
     * @returns Paths actually written. An empty array is the ordinary result
     * of a no-op export and is not a failure.
     */
    async exportAll(): Promise<string[]> {
        const enabled = this.enabledCalendars();
        if (enabled.length === 0) {
            return [];
        }

        const folder = this.folder();
        if (!this.vault.getAbstractFileByPath(folder)) {
            await this.vault.createFolder(folder);
        }

        const written: string[] = [];
        const taken = new Set<string>();
        for (const { calendarId, calendar, reminderMinutes } of enabled) {
            const basename = disambiguate(slugifyTitle(calendar.name), (name) =>
                taken.has(name)
            );
            taken.add(basename);

            const path = `${folder}/${basename}${ICS_SUFFIX}`;
            const text = exportToIcs(await this.entriesFor(calendarId), {
                calendarName: calendar.name,
                reminderMinutes: reminderMinutes,
            });
            if (await this.writeIfChanged(path, text)) {
                written.push(path);
            }
        }
        return written;
    }

    /**
     * The calendars to export, with the settings that govern each.
     *
     * Read off the settings row each calendar was built from rather than off
     * the calendar itself: whether a calendar is exported is a preference, not
     * a property of the source, and the calendar object has no opinion on it.
     *
     * Read-only calendars are skipped. A derived calendar is a projection of
     * notes that already have a home elsewhere, so exporting one would put the
     * same event on the phone twice.
     */
    private enabledCalendars(): {
        calendarId: string;
        calendar: EditableCalendar;
        reminderMinutes: number | null;
    }[] {
        return [...this.cache.calendars.entries()].flatMap(
            ([calendarId, calendar]) => {
                const info = this.cache.infoFor(calendarId);
                if (!info?.exportToICS) {
                    return [];
                }
                if (!(calendar instanceof EditableCalendar)) {
                    return [];
                }
                return [
                    {
                        calendarId,
                        calendar,
                        reminderMinutes: info.reminderMinutes ?? null,
                    },
                ];
            }
        );
    }

    /**
     * Every event in a calendar, with its identity and parentage settled.
     *
     * Two things happen here that `ics_export.ts` deliberately cannot do for
     * itself: a uid is assigned to anything that lacks one, which means writing
     * to a note, and an override is paired with the master whose occurrence it
     * replaces, which means following a wikilink.
     */
    private async entriesFor(calendarId: string): Promise<ExportEntry[]> {
        const stored = this.cache.eventsInCalendar(calendarId);
        const uids = new Map<string, string>();
        for (const { id } of stored) {
            uids.set(id, await this.uidFor(id));
        }

        const entries: ExportEntry[] = [];
        for (const { id, event } of stored) {
            const uid = uids.get(id) as string;
            if (!isOverride(event)) {
                entries.push({ event, uid });
                continue;
            }

            const masterId = this.cache.masterOf(id);
            const master = masterId ? this.cache.getEventById(masterId) : null;
            const masterUid = masterId ? uids.get(masterId) : undefined;
            if (!master || !masterUid) {
                // Its series is missing, or lives in another calendar and so is
                // not in this file. Emitted alone it would show its day twice —
                // once as itself and once as the occurrence it was meant to
                // replace — so it is left out and said out loud.
                console.warn(
                    `FC: "${event.title}" replaces an occurrence of a series that is not in this export, so it has been left out of it.`
                );
                continue;
            }
            entries.push({
                event,
                uid,
                parent: { uid: masterUid, event: master },
            });
        }
        return entries;
    }

    /**
     * The uid of an event, assigning and storing one if it has none.
     *
     * Written through the cache, so the note, the store and the view all learn
     * about it together. This is the only thing an export writes to a note, and
     * it happens once in an event's life.
     */
    private async uidFor(eventId: string): Promise<string> {
        const event = this.cache.getEventById(eventId);
        if (!event) {
            throw new Error(`Event ID ${eventId} vanished mid-export.`);
        }
        if (event.uid) {
            return event.uid;
        }
        const uid = newUid();
        await this.cache.processEvent(eventId, (stale: FerryEvent) => ({
            ...stale,
            uid,
        }));
        return uid;
    }

    /**
     * Write the export, unless it would say exactly what the file already says.
     *
     * @returns Whether anything was written.
     */
    private async writeIfChanged(path: string, text: string): Promise<boolean> {
        const existing = this.vault.getFileByPath(path);
        if (!existing) {
            await this.vault.create(path, text);
            return true;
        }
        const before = await this.vault.read(existing);
        if (sameIgnoringStamps(before, text)) {
            return false;
        }
        await this.vault.rewrite(existing, () => text);
        return true;
    }
}
