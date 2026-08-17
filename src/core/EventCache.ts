import { Notice, TFile } from "obsidian";
import equal from "deep-equal";

import { Calendar } from "../calendars/Calendar";
import { EditableCalendar } from "../calendars/EditableCalendar";
import EventStore, { StoredEvent } from "./EventStore";
import { CalendarInfo, FerryEvent, validateEvent } from "../types";
import { isOverride } from "../types/schema";
import {
    overrideOf,
    seriesFrom,
    truncateSeriesBefore,
} from "../calendars/recurrence_edit";
import RemoteCalendar from "../calendars/RemoteCalendar";
import FullNoteCalendar from "../calendars/FullNoteCalendar";
import { VaultCalendar } from "../calendars/VaultCalendar";

export type CalendarInitializerMap = Record<
    CalendarInfo["type"],
    (info: CalendarInfo) => Calendar | null
>;

export type CacheEntry = { event: FerryEvent; id: string; calendarId: string };

export type UpdateViewCallback = (
    info:
        | {
              type: "events";
              toRemove: string[];
              toAdd: CacheEntry[];
          }
        | { type: "calendar"; calendar: FerryEventSource }
        | { type: "resync" }
) => void;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const MILLICONDS_BETWEEN_REVALIDATIONS = 5 * MINUTE;

// TODO: Write tests for this function.
export const eventsAreDifferent = (
    oldEvents: FerryEvent[],
    newEvents: FerryEvent[]
): boolean => {
    oldEvents.sort((a, b) => a.title.localeCompare(b.title));
    newEvents.sort((a, b) => a.title.localeCompare(b.title));

    // validateEvent() will normalize the representation of default fields in events.
    oldEvents = oldEvents.flatMap((e) => validateEvent(e) || []);
    newEvents = newEvents.flatMap((e) => validateEvent(e) || []);

    console.debug("comparing events", oldEvents, newEvents);

    if (oldEvents.length !== newEvents.length) {
        return true;
    }

    const unmatchedEvents = oldEvents
        .map((e, i) => ({ oldEvent: e, newEvent: newEvents[i] }))
        .filter(({ oldEvent, newEvent }) => !equal(oldEvent, newEvent));

    if (unmatchedEvents.length > 0) {
        console.debug("unmached events when comparing", unmatchedEvents);
    }

    return unmatchedEvents.length > 0;
};

export type CachedEvent = Pick<StoredEvent, "event" | "id">;

export type FerryEventSource = {
    events: CachedEvent[];
    editable: boolean;
    color: string;
    id: string;
    /** Calendar type, so the view can label a source without parsing its id. */
    type: CalendarInfo["type"];
    /** The calendar's own name: a directory, a heading, or a URL. */
    name: string;
};

/**
 * Persistent event cache that also can write events back to disk.
 *
 * The EventCache acts as the bridge between the source-of-truth for
 * calendars (either the network or filesystem) and the FullCalendar view plugin.
 *
 * It maintains its own copy of all events which should be displayed on calendars
 * in the internal event format.
 *
 * Pluggable Calendar classes are responsible for parsing and serializing events
 * from their source, but the EventCache performs all I/O itself.
 *
 * Subscribers can register callbacks on the EventCache to be updated when events
 * change on disk.
 */
export default class EventCache {
    private calendarInfos: CalendarInfo[] = [];

    private calendarInitializers: CalendarInitializerMap;

    private store = new EventStore();
    calendars = new Map<string, Calendar>();

    private pkCounter = 0;

    private revalidating = false;

    generateId(): string {
        return `${this.pkCounter++}`;
    }

    private updateViewCallbacks: UpdateViewCallback[] = [];

    /**
     * Which occurrences were replaced as of the last view update.
     *
     * Kept so `updateViews` can tell that a series needs redrawing when the
     * series itself has not changed — see `mastersWithChangedOverrides`. Reset
     * with the store, since a fresh cache has drawn nothing yet.
     */
    private lastOverriddenOccurrences: Map<string, string[]> = new Map();

    initialized = false;

    lastRevalidation: number = 0;

    constructor(calendarInitializers: CalendarInitializerMap) {
        this.calendarInitializers = calendarInitializers;
    }

    /**
     * Flush the cache and initialize calendars from the initializer map.
     */
    reset(infos: CalendarInfo[]): void {
        this.lastRevalidation = 0;
        this.initialized = false;
        this.calendarInfos = infos;
        this.pkCounter = 0;
        this.calendars.clear();
        this.store.clear();
        this.lastOverriddenOccurrences.clear();
        this.resync();
        this.init();
    }

    init() {
        this.calendarInfos
            .flatMap((s) => {
                const cal = this.calendarInitializers[s.type](s);
                return cal || [];
            })
            .forEach((cal) => this.calendars.set(cal.id, cal));
    }

    /**
     * Populate the cache with events.
     */
    async populate(): Promise<void> {
        if (!this.initialized || this.calendars.size === 0) {
            this.init();
        }
        for (const calendar of this.calendars.values()) {
            const results = await calendar.getEvents();
            results.forEach(([event, location]) =>
                this.store.add({
                    calendar,
                    location,
                    id: event.id || this.generateId(),
                    event,
                })
            );
        }
        // The view rebuilds from `getAllEvents` after this, so what it has just
        // drawn is the baseline: without it, the first write of the session
        // would report every overridden series as newly changed.
        this.lastOverriddenOccurrences = this.overriddenOccurrences();
        this.initialized = true;
        this.revalidateRemoteCalendars();
    }

    resync(): void {
        for (const callback of this.updateViewCallbacks) {
            callback({ type: "resync" });
        }
    }

    /**
     * Get all events from the cache in a FullCalendar-friendly format.
     * @returns EventSourceInputs for FullCalendar.
     */
    getAllEvents(): FerryEventSource[] {
        const result: FerryEventSource[] = [];
        const eventsByCalendar = this.store.eventsByCalendar;
        for (const [calId, calendar] of this.calendars.entries()) {
            const events = eventsByCalendar.get(calId) || [];
            result.push({
                editable: calendar instanceof EditableCalendar,
                events: events.map(({ event, id }) => ({ event, id })), // make sure not to leak location data past the cache.
                color: calendar.color,
                id: calId,
                type: calendar.type,
                name: calendar.name,
            });
        }
        return result;
    }

    /**
     * Check if an event is part of an editable calendar.
     * @param id ID of event to check
     * @returns
     */
    isEventEditable(id: string): boolean {
        const calId = this.store.getEventDetails(id)?.calendarId;
        if (!calId) {
            return false;
        }
        const cal = this.getCalendarById(calId);
        return cal instanceof EditableCalendar;
    }

    getEventById(s: string): FerryEvent | null {
        return this.store.getEventById(s);
    }

    /**
     * The occurrences that override notes stand in for, by master event ID.
     *
     * PLANNING §3.2 puts the splice in the expander rather than on disk: an
     * edited occurrence becomes its own note and the master is left alone, so
     * the only record that a generated occurrence has been replaced is the
     * `recurrenceId` on the note replacing it. The render path asks for that
     * here and cancels those dates, which is what stops the day showing twice.
     *
     * Deliberately computed rather than indexed. An index would have to be
     * maintained across every add, delete, rename and external file change —
     * the one thing that has to stay correct for an occurrence not to be
     * silently lost or doubled — and at the scale in §8 a pass over the store
     * costs nothing. Overrides are found by following `recurringParent` to a
     * note and looking up what is stored at that path.
     *
     * A parent that resolves to nothing is warned about and skipped: the field
     * is hand-editable, and a broken link should leave the series rendering as
     * it did before rather than take the calendar down.
     *
     * @returns Master event ID → the occurrence dates replaced, ISO
     * `YYYY-MM-DD`. Masters with no overrides are absent rather than empty.
     */
    overriddenOccurrences(): Map<string, string[]> {
        const byMaster = new Map<string, string[]>();
        for (const [calendarId, stored] of this.store.eventsByCalendar) {
            const calendar = this.calendars.get(calendarId);
            if (!(calendar instanceof EditableCalendar)) {
                continue;
            }
            for (const { event, location } of stored) {
                if (!isOverride(event) || !location) {
                    continue;
                }
                const masterId = this.masterAt(
                    calendar.resolveLink(event.recurringParent, location.path),
                    event
                );
                if (masterId === null) {
                    continue;
                }
                byMaster.set(masterId, [
                    ...(byMaster.get(masterId) ?? []),
                    event.recurrenceId,
                ]);
            }
        }
        return byMaster;
    }

    /**
     * ID of the recurring event stored at a path, for an override that claims
     * to replace one of its occurrences.
     *
     * @param path Where `recurringParent` resolved to, or null if it resolved
     * nowhere.
     * @param override The override doing the claiming, named in the warning so
     * the user can find the note whose link needs fixing.
     * @returns The master's event ID, or null if the link led nowhere, to a
     * note holding no event, or to an event that does not repeat.
     */
    private masterAt(path: string | null, override: FerryEvent): string | null {
        if (path === null) {
            console.warn(
                `FC: "${override.title}" replaces an occurrence of a series its recurringParent does not point at any more, so the occurrence it replaces is still on the calendar.`
            );
            return null;
        }
        const master = this.store
            .getEventsInFile({ path })
            .find(({ event }) => event.type === "recurring");
        if (!master) {
            console.warn(
                `FC: "${override.title}" points at ${path}, which holds no recurring event, so the occurrence it replaces is still on the calendar.`
            );
            return null;
        }
        return master.id;
    }

    getCalendarById(c: string): Calendar | undefined {
        return this.calendars.get(c);
    }

    /**
     * Path of the note an event was read from, or null if it has none.
     *
     * Remote events have no note behind them; events from any vault calendar
     * do, editable or not. Callers offering to *open* the note want this, since
     * asking whether an event can be edited answers a different question.
     * @param eventId ID of event in question.
     */
    getNotePathForEvent(eventId: string): string | null {
        return this.store.getEventDetails(eventId)?.location?.path ?? null;
    }

    /**
     * Get calendar and location information for a given event in the Vault.
     * Throws an error if event is not found or if it does not have a location in the Vault.
     *
     * Deliberately indifferent to whether the calendar is editable: opening the
     * note an event came from is as valid for a read-only projection as for an
     * event the plugin owns. Anything that intends to *write* must go through
     * getInfoForEditableEvent instead.
     * @param eventId ID of event in question.
     * @returns Calendar and location for an event.
     */
    getInfoForEvent(eventId: string) {
        const { calendar, location } = this.resolveEvent(eventId);
        if (!location) {
            throw new Error(
                `Event with ID ${eventId} does not have a location in the Vault.`
            );
        }
        return { calendar, location };
    }

    /**
     * As getInfoForEvent, but only for events the plugin may write back.
     *
     * Editability is checked first on purpose: when a write is attempted
     * against a read-only calendar, that is the useful thing to say, even if
     * the event also happens to have no location.
     * @param eventId ID of event in question.
     * @returns Calendar and location for an event.
     */
    getInfoForEditableEvent(eventId: string) {
        const { calendar } = this.resolveEvent(eventId);
        if (!(calendar instanceof EditableCalendar)) {
            throw new Error(`Read-only events cannot be modified.`);
        }
        const { location } = this.getInfoForEvent(eventId);
        return { calendar, location };
    }

    /**
     * Look up an event's calendar and its location, which may be absent.
     * @param eventId ID of event in question.
     */
    private resolveEvent(eventId: string) {
        const details = this.store.getEventDetails(eventId);
        if (!details) {
            throw new Error(`Event ID ${eventId} not present in event store.`);
        }
        const { calendarId, location } = details;
        const calendar = this.calendars.get(calendarId);
        if (!calendar) {
            throw new Error(`Calendar ID ${calendarId} is not registered.`);
        }
        return { calendar, location };
    }

    ///
    // View Callback functions
    ///

    /**
     * Register a callback for a view.
     * @param eventType event type (currently just "update")
     * @param callback
     * @returns reference to callback for de-registration.
     */
    on(eventType: "update", callback: UpdateViewCallback) {
        switch (eventType) {
            case "update":
                this.updateViewCallbacks.push(callback);
                break;
        }
        return callback;
    }

    /**
     * De-register a callback for a view.
     * @param eventType event type
     * @param callback callback to remove
     */
    off(eventType: "update", callback: UpdateViewCallback) {
        switch (eventType) {
            case "update":
                this.updateViewCallbacks.remove(callback);
                break;
        }
    }

    /**
     * Push updates to all subscribers.
     *
     * A series whose overrides changed is redrawn alongside whatever else
     * changed, because a master renders occurrences that other notes cancel:
     * delete the note replacing an occurrence and the occurrence has to come
     * back, and nothing about the master itself changed to say so.
     *
     * Done here rather than at each write because there are five ways to reach
     * one — an override created, deleted, edited back into an ordinary event,
     * deleted with its file, or changed outside the plugin entirely — and the
     * failure when one is missed is silent: a day that shows twice, or not at
     * all, until the next resync.
     *
     * @param toRemove IDs of events to remove from the view.
     * @param toAdd Events to add to the view.
     */
    private updateViews(toRemove: string[], toAdd: CacheEntry[]) {
        const affected = this.mastersWithChangedOverrides(toRemove, toAdd);
        const payload = {
            toRemove: [...toRemove, ...affected.map(({ id }) => id)],
            toAdd: [...toAdd, ...affected],
        };

        for (const callback of this.updateViewCallbacks) {
            callback({ type: "events", ...payload });
        }
    }

    /**
     * Series that have to be redrawn because their overrides have changed.
     *
     * Compares the overrides in the store now against those at the last update
     * rather than tracking which writes touch an override. The whole map is
     * recomputed each time and replaces the last, so it cannot drift out of
     * step with the store the way a maintained index would — and drift here is
     * exactly the failure that would be invisible.
     *
     * @param toRemove IDs already leaving the view.
     * @param toAdd Events already being drawn.
     * @returns Masters not already in the update, still in the store, whose set
     * of replaced occurrences differs from last time.
     */
    private mastersWithChangedOverrides(
        toRemove: string[],
        toAdd: CacheEntry[]
    ): CacheEntry[] {
        const current = this.overriddenOccurrences();
        const previous = this.lastOverriddenOccurrences;
        this.lastOverriddenOccurrences = current;

        const changed = [...new Set([...current.keys(), ...previous.keys()])]
            .filter(
                (id) =>
                    (current.get(id) ?? []).join() !==
                    (previous.get(id) ?? []).join()
            )
            // A master already being redrawn picks the change up anyway, and
            // one being deleted must not be drawn again.
            .filter(
                (id) =>
                    !toRemove.includes(id) &&
                    !toAdd.some((entry) => entry.id === id)
            );

        return changed.flatMap((id) => {
            const details = this.store.getEventDetails(id);
            return details
                ? [{ id, event: details.event, calendarId: details.calendarId }]
                : [];
        });
    }

    private updateCalendar(calendar: FerryEventSource) {
        for (const callback of this.updateViewCallbacks) {
            callback({ type: "calendar", calendar });
        }
    }

    ///
    // Functions to update the cache from the view layer.
    ///

    /**
     * Add an event to a given calendar.
     * @param calendarId ID of calendar to add event to.
     * @param event Event details
     * @returns Returns true if successful, false otherwise.
     */
    async addEvent(calendarId: string, event: FerryEvent): Promise<boolean> {
        const calendar = this.calendars.get(calendarId);
        if (!calendar) {
            throw new Error(`Calendar ID ${calendarId} is not registered.`);
        }
        if (!(calendar instanceof EditableCalendar)) {
            console.error(
                `Event cannot be added to non-editable calendar of type ${calendar.type}`
            );
            throw new Error(`Cannot add event to a read-only calendar`);
        }
        const location = await calendar.createEvent(event);
        const id = this.store.add({
            calendar,
            location,
            id: event.id || this.generateId(),
            event,
        });

        this.updateViews([], [{ event, id, calendarId: calendar.id }]);
        return true;
    }

    /**
     * Materialise the note that replaces one occurrence of a series.
     *
     * The master is left exactly as it was — PLANNING §3.2 keeps the record of
     * a replaced occurrence on the note doing the replacing, so what this adds
     * is one ordinary single event that happens to remember where it came
     * from. It lands in the master's own calendar, and `folderForEvent` files
     * it among the dated notes rather than in `_recurring/`, because that is
     * what it now is.
     *
     * The master is re-rendered afterwards even though it has not changed — the
     * occurrence it generates on this date has to stop being drawn — but that
     * happens in `updateViews`, which redraws a series whenever its overrides
     * change however they came to change.
     *
     * @param masterId ID of the recurring event whose occurrence is replaced.
     * @param occurrence The date the rule generated it on, ISO `YYYY-MM-DD`.
     * @param edited The occurrence as the user has just edited it.
     * @throws If the ID is not a recurring event. The caller has already
     * decided it is splitting a series, so anything else means it looked up the
     * wrong event, and writing the override anyway would leave a note pointing
     * at a master that cannot generate the occurrence it claims to replace.
     */
    async createOverride(
        masterId: string,
        occurrence: string,
        edited: FerryEvent
    ): Promise<boolean> {
        const { calendar, location } = this.getInfoForEditableEvent(masterId);
        const master = this.store.getEventById(masterId);
        if (master?.type !== "recurring") {
            throw new Error(
                `Cannot replace an occurrence of event ID ${masterId}: it is not a recurring event.`
            );
        }

        await this.addEvent(
            calendar.id,
            overrideOf(edited, occurrence, calendar.linkTo(location.path))
        );
        return true;
    }

    /**
     * Split a series in two at one occurrence, carrying an edit into the half
     * that follows.
     *
     * "This and following", which PLANNING §3.2 declines to model: the old
     * master is capped with `until` and a second master takes over from the
     * edit date, so what the user gets is two ordinary series rather than a
     * third kind of record with a pointer between them.
     *
     * The new series is built before anything is written, so an edit that
     * cannot become a series leaves the original untouched rather than capping
     * it and then failing to replace the half it removed.
     *
     * @param masterId ID of the series being split.
     * @param occurrence The first occurrence the edit applies to, ISO
     * `YYYY-MM-DD`.
     * @param edited The event as the user has just edited it, rule and all.
     * @throws If the ID is not a recurring event, or if the edit is not one —
     * an edit that removed the rule is a request to stop repeating, which is
     * not something half a series can express.
     */
    async splitSeriesAt(
        masterId: string,
        occurrence: string,
        edited: FerryEvent
    ): Promise<void> {
        const { calendar } = this.getInfoForEditableEvent(masterId);
        const master = this.store.getEventById(masterId);
        if (master?.type !== "recurring") {
            throw new Error(
                `Cannot split event ID ${masterId}: it is not a recurring event.`
            );
        }

        const capped = truncateSeriesBefore(master, occurrence);
        const next = seriesFrom(edited, occurrence);

        if (capped === null) {
            // The user edited from the first occurrence onwards, so nothing is
            // left of the original half and the new series simply replaces it.
            await this.deleteEvent(masterId);
        } else {
            await this.updateEventWithId(masterId, capped);
        }
        await this.addEvent(calendar.id, next);
    }

    /**
     * Delete an event by its ID.
     * @param eventId ID of event to be deleted.
     */
    async deleteEvent(eventId: string): Promise<void> {
        const { calendar, location } = this.getInfoForEditableEvent(eventId);
        this.store.delete(eventId);
        await calendar.deleteEvent(location);
        this.updateViews([eventId], []);
    }

    /**
     * Update an event with a given ID.
     * @param eventId ID of event to update.
     * @param newEvent new event contents
     * @returns true if update was successful, false otherwise.
     */
    async updateEventWithId(
        eventId: string,
        newEvent: FerryEvent
    ): Promise<boolean> {
        const { calendar, location: oldLocation } =
            this.getInfoForEditableEvent(eventId);
        const { path, lineNumber } = oldLocation;
        console.debug("updating event with ID", eventId);

        await calendar.modifyEvent(
            { path, lineNumber },
            newEvent,
            (newLocation) => {
                this.store.delete(eventId);
                this.store.add({
                    calendar,
                    location: newLocation,
                    id: eventId,
                    event: newEvent,
                });
            }
        );

        this.updateViews(
            [eventId],
            [{ id: eventId, calendarId: calendar.id, event: newEvent }]
        );
        return true;
    }

    /**
     * Transform an event that's already in the event store.
     *
     * A more "type-safe" wrapper around updateEventWithId(),
     * use this function if the caller is only modifying few
     * known properties of an event.
     * @param id ID of event to transform.
     * @param process function to transform the event.
     * @returns true if the update was successful.
     */
    processEvent(
        id: string,
        process: (e: FerryEvent) => FerryEvent
    ): Promise<boolean> {
        const event = this.store.getEventById(id);
        if (!event) {
            throw new Error("Event does not exist");
        }
        const newEvent = process(event);
        console.debug("process", newEvent, process);
        return this.updateEventWithId(id, newEvent);
    }

    async moveEventToCalendar(
        eventId: string,
        newCalendarId: string
    ): Promise<void> {
        const event = this.store.getEventById(eventId);
        const details = this.store.getEventDetails(eventId);
        if (!details || !event) {
            throw new Error(
                `Tried moving unknown event ID ${eventId} to calendar ${newCalendarId}`
            );
        }
        const { calendarId: oldCalendarId, location } = details;

        const oldCalendar = this.calendars.get(oldCalendarId);
        if (!oldCalendar) {
            throw new Error(`Source calendar ${oldCalendarId} did not exist.`);
        }
        const newCalendar = this.calendars.get(newCalendarId);
        if (!newCalendar) {
            throw new Error(`Source calendar ${newCalendarId} does not exist.`);
        }

        // TODO: Support moving around events between all sorts of editable calendars.
        if (
            !(
                oldCalendar instanceof FullNoteCalendar &&
                newCalendar instanceof FullNoteCalendar &&
                location
            )
        ) {
            throw new Error(
                `Both calendars must be Full Note Calendars to move events between them.`
            );
        }

        await oldCalendar.move(location, newCalendar, (newLocation) => {
            this.store.delete(eventId);
            this.store.add({
                calendar: newCalendar,
                location: newLocation,
                id: eventId,
                event,
            });
        });
    }

    ///
    // Filesystem hooks
    ///

    /**
     * Delete all events located at a given path and notify subscribers.
     * @param path path of file that has been deleted
     */
    deleteEventsAtPath(path: string) {
        this.updateViews([...this.store.deleteEventsAtPath(path)], []);
    }

    /**
     * Main hook into the filesystem.
     * This callback should be called whenever a file has been updated or created.
     * @param file File which has been updated
     * @returns nothing
     */
    async fileUpdated(file: TFile): Promise<void> {
        console.debug("fileUpdated() called for file", file.path);

        // Get all calendars that contain events stored in this file. Any
        // vault-sourced calendar reloads here, editable or not: a read-only
        // calendar still has to notice when its source note changes.
        const calendars = [...this.calendars.values()].flatMap((c) =>
            c instanceof VaultCalendar && c.containsPath(file.path) ? c : []
        );

        // If no calendars exist, return early.
        if (calendars.length === 0) {
            return;
        }

        const idsToRemove: string[] = [];
        const eventsToAdd: CacheEntry[] = [];

        for (const calendar of calendars) {
            const oldEvents = this.store.getEventsInFileAndCalendar(
                file,
                calendar
            );
            // TODO: Relying on calendars for file I/O means that we're potentially
            // reading the file from disk multiple times. Could be more effecient if
            // we break the abstraction layer here.
            console.debug("get events in file", file.path);
            const newEvents = await calendar.getEventsInFile(file);

            const oldEventsMapped = oldEvents.map(({ event }) => event);
            const newEventsMapped = newEvents.map(([event, _]) => event);
            console.debug("comparing events", file.path, oldEvents, newEvents);
            // TODO: It's possible events are not different, but the location has changed.
            const eventsHaveChanged = eventsAreDifferent(
                oldEventsMapped,
                newEventsMapped
            );

            // If no events have changed from what's in the cache, then there's no need to update the event store.
            // Skip only this calendar, not the rest: several calendars can read
            // the same file — two mappings over one directory, say — and an
            // unchanged first one must not abandon the others.
            if (!eventsHaveChanged) {
                console.debug(
                    "events have not changed, do not update store or view."
                );
                continue;
            }
            console.debug(
                "events have changed, updating store and views...",
                oldEvents,
                newEvents
            );

            const newEventsWithIds = newEvents.map(([event, location]) => ({
                event,
                id: event.id || this.generateId(),
                location,
                calendarId: calendar.id,
            }));

            // If events have changed in the calendar, then remove all the old events from the store and add in new ones.
            const oldIds = oldEvents.map((r: StoredEvent) => r.id);
            oldIds.forEach((id: string) => {
                this.store.delete(id);
            });
            newEventsWithIds.forEach(({ event, id, location }) => {
                this.store.add({
                    calendar,
                    location,
                    id,
                    event,
                });
            });

            idsToRemove.push(...oldIds);
            eventsToAdd.push(...newEventsWithIds);
        }

        // Every calendar reading this file may have found nothing to change, in
        // which case subscribers get no callback at all rather than an empty one.
        if (idsToRemove.length === 0 && eventsToAdd.length === 0) {
            return;
        }

        this.updateViews(idsToRemove, eventsToAdd);
    }

    /**
     * Revalidate calendars asynchronously. This is not a blocking function: as soon as new data
     * is available for any remote calendar, its data will be updated in the cache and any subscribing views.
     */
    revalidateRemoteCalendars(force = false) {
        if (this.revalidating) {
            console.warn("Revalidation already in progress.");
            return;
        }
        const now = Date.now();

        if (
            !force &&
            now - this.lastRevalidation < MILLICONDS_BETWEEN_REVALIDATIONS
        ) {
            console.debug("Last revalidation was too soon.");
            return;
        }

        const remoteCalendars = [...this.calendars.values()].flatMap((c) =>
            c instanceof RemoteCalendar ? c : []
        );

        console.warn("Revalidating remote calendars...");
        this.revalidating = true;
        const promises = remoteCalendars.map((calendar) => {
            return calendar
                .revalidate()
                .then(() => calendar.getEvents())
                .then((events) => {
                    const deletedEvents = [
                        ...this.store.deleteEventsInCalendar(calendar),
                    ];
                    const newEvents = events.map(([event, location]) => ({
                        event,
                        id: event.id || this.generateId(),
                        location,
                        calendarId: calendar.id,
                    }));
                    newEvents.forEach(({ event, id, location }) => {
                        this.store.add({
                            calendar,
                            location,
                            id,
                            event,
                        });
                    });
                    this.updateCalendar({
                        id: calendar.id,
                        editable: false,
                        color: calendar.color,
                        type: calendar.type,
                        name: calendar.name,
                        events: newEvents,
                    });
                });
        });
        Promise.allSettled(promises).then((results) => {
            this.revalidating = false;
            this.lastRevalidation = Date.now();
            console.debug("All remote calendars have been fetched.");
            const errors = results.flatMap((result) =>
                result.status === "rejected" ? result.reason : []
            );
            if (errors.length > 0) {
                new Notice(
                    "A remote calendar failed to load. Check the console for more details."
                );
                errors.forEach((reason) => {
                    console.error(`Revalidation failed with reason: ${reason}`);
                });
            }
        });
    }

    get _storeForTest() {
        return this.store;
    }
}
