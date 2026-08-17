import { EventPathLocation } from "src/core/EventStore";
import { EventLocation, FerryEvent } from "src/types";
import { VaultCalendar, VaultEventResponse } from "./VaultCalendar";

export type EditableEventResponse = VaultEventResponse;

/**
 * Abstract class representing the interface for an Calendar whose source-of-truth
 * is the Obsidian Vault and which the plugin is allowed to write back to.
 *
 * EditableCalendar instances handle all file I/O, typically through an ObsidianInterface.
 * The EventCache will call methods on an EditableCalendar to make updates to the Vault from user action, as well
 * as to parse events from files when the files are updated outside of Ferry Calendar.
 *
 * The write methods below are what separates this from a plain VaultCalendar:
 * read-only calendar types extend that instead, so they have no write path to
 * their source notes at all rather than a disabled one.
 */
export abstract class EditableCalendar extends VaultCalendar {
    constructor(color: string) {
        super(color);
    }

    /**
     * Create an event in this calendar.
     * @param event Event to create.
     */
    abstract createEvent(event: FerryEvent): Promise<EventLocation>;

    /**
     * Delete an event from the calendar.
     * @param location Location of event to delete.
     */
    abstract deleteEvent(location: EventPathLocation): Promise<void>;

    /**
     * Modify an event on disk.
     *
     * @param location Location of event
     * @param newEvent New event details
     * @param updateCacheWithLocation This callback updates the cache with the new location
     *        of the event. In order to avoid race conditions with file I/O, make sure this
     *        is called before any files are changed on disk.
     */
    abstract modifyEvent(
        location: EventPathLocation,
        newEvent: FerryEvent,
        updateCacheWithLocation: (loc: EventLocation) => void
    ): Promise<void>;

    /**
     * A link pointing at one of this calendar's notes.
     *
     * Written into an override's `recurringParent`. A link rather than a path
     * because Obsidian maintains links: this plugin renames event notes
     * whenever a date or title changes, and a stored path would be stale the
     * first time the master's DTSTART moved.
     *
     * @param path Vault path of the note to point at.
     */
    abstract linkTo(path: string): string;

    /**
     * Follow a link stored in one of this calendar's notes.
     *
     * The counterpart to `linkTo`, and the reason both live here rather than on
     * `FullNoteCalendar` alone: the cache pairs an override with the master it
     * replaces without knowing which kind of calendar either sits in.
     *
     * @param link Field value, expected as `[[target]]`.
     * @param fromPath Path of the note holding the link, since resolution is
     * relative to it just as it is for a link in a note's body.
     * @returns Path of the note it points at, or null if the value is not a
     * link or resolves to nothing.
     */
    abstract resolveLink(link: string, fromPath: string): string | null;
}
