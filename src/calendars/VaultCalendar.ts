import { TFile } from "obsidian";
import { EventLocation, FerryEvent } from "../types";
import { Calendar } from "./Calendar";

export type VaultEventResponse = [FerryEvent, EventLocation];

/**
 * A calendar whose events are parsed out of notes in the Vault.
 *
 * This is the seam between "where do the events come from" and "who may write
 * them". Both an EditableCalendar and a read-only derived calendar read notes
 * from a directory and must react when those notes change, but only the former
 * has any write path to them. Anything that needs to reload events after a file
 * changes should look for a VaultCalendar; anything that intends to *modify* an
 * event must still require an EditableCalendar.
 *
 * Remote calendars are deliberately not part of this hierarchy: they have no
 * directory and no per-file reload, and refresh through `revalidate()` instead.
 */
export abstract class VaultCalendar extends Calendar {
    /**
     * Directory this calendar sources its events from.
     */
    abstract get directory(): string;

    /**
     * Returns true if this calendar sources events from the given path.
     *
     * The trailing separator is load-bearing: a bare `startsWith` on the
     * directory makes a calendar at `CALENDARS/WORK` claim every note under
     * `CALENDARS/WORK2`, and the two calendars would then fight over the same
     * files whenever one of them changed.
     *
     * Subclasses that read only part of their directory tree narrow this
     * further; nothing may widen it.
     */
    containsPath(path: string): boolean {
        if (this.directory === "") {
            // A calendar rooted at the vault root contains everything.
            return true;
        }
        return path.startsWith(`${this.directory}/`);
    }

    /**
     * Get all events in a given file.
     *
     * Every event read from a note has a location by construction — the note it
     * came from — so unlike `Calendar.getEvents`, the location here is not
     * nullable.
     *
     * @param file File to parse
     */
    abstract getEventsInFile(file: TFile): Promise<VaultEventResponse[]>;
}
