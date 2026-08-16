import { TFile, TFolder } from "obsidian";
import { EventPathLocation } from "../core/EventStore";
import { ObsidianInterface } from "../ObsidianAdapter";
import { FerryEvent, EventLocation, validateEvent } from "../types";
import { replacedKeys, serializeEvent } from "../types/schema";
import { EditableCalendar, EditableEventResponse } from "./EditableCalendar";
import {
    basenameForEvent,
    basenameMatchesEvent,
    DEFAULT_FILENAME_DATE_FORMAT,
    disambiguate,
    FilenameDateFormat,
} from "./filenames";
import {
    CalendarRepairPlan,
    PlannableNote,
    PlannedRename,
    planRepairs,
} from "./filename_repair";
import { modifyFrontmatterString, newFrontmatter } from "./frontmatter";

export default class FullNoteCalendar extends EditableCalendar {
    app: ObsidianInterface;
    private _directory: string;
    private dateFormat: FilenameDateFormat;

    /**
     * @param dateFormat How to render the date prefix of event filenames. A
     * user preference rather than a property of the calendar, passed in so that
     * the naming rules have a single owner.
     */
    constructor(
        app: ObsidianInterface,
        color: string,
        directory: string,
        dateFormat: FilenameDateFormat = DEFAULT_FILENAME_DATE_FORMAT
    ) {
        super(color);
        this.app = app;
        this._directory = directory;
        this.dateFormat = dateFormat;
    }
    get directory(): string {
        return this._directory;
    }

    /**
     * Working-calendar notes live directly in the calendar's own folder.
     *
     * Narrower than the base implementation on purpose, and it has to be:
     * `getEvents` reads only the folder's immediate children, so without this a
     * note in a subfolder would be invisible on load but parsed as an ordinary
     * event the moment it was edited — present on the calendar or not depending
     * on which code path last ran.
     *
     * The subfolder that matters today is `_recurring/`. Masters stored there
     * are not ordinary events and nothing parses them until the recurrence
     * slice lands; treating one as a single event because it happens to carry a
     * date would put a phantom on the calendar.
     */
    containsPath(path: string): boolean {
        if (!super.containsPath(path)) {
            return false;
        }
        const relative =
            this.directory === ""
                ? path
                : path.slice(this.directory.length + 1);
        return !relative.includes("/");
    }

    /**
     * Whether a basename is already used by a note in the given folder.
     *
     * @param folder Folder to check within.
     * @param basename Candidate basename, without the `.md` extension.
     * @param exceptPath A path that does not count as a collision, so a file
     * being renamed does not collide with itself.
     */
    private isTaken(
        folder: string,
        basename: string,
        exceptPath?: string
    ): boolean {
        const path = `${folder}/${basename}.md`;
        if (path === exceptPath) {
            return false;
        }
        return this.app.getAbstractFileByPath(path) !== null;
    }

    /**
     * The filename a note holding this event should have, free of collisions.
     *
     * @param folder Folder the note lives in.
     * @param event Event to name.
     * @param currentPath Path of the note today, when it already exists.
     */
    private freeBasenameFor(
        folder: string,
        event: FerryEvent,
        currentPath?: string
    ): string {
        return disambiguate(basenameForEvent(event, this.dateFormat), (name) =>
            this.isTaken(folder, name, currentPath)
        );
    }

    get type(): "local" {
        return "local";
    }

    get identifier(): string {
        return this.directory;
    }

    get name(): string {
        return this.directory;
    }

    async getEventsInFile(file: TFile): Promise<EditableEventResponse[]> {
        const metadata = this.app.getMetadata(file);
        let event = validateEvent(metadata?.frontmatter);
        if (!event) {
            return [];
        }
        if (!event.title) {
            event.title = file.basename;
        }
        return [[event, { file, lineNumber: undefined }]];
    }

    private async getEventsInFolderRecursive(
        folder: TFolder
    ): Promise<EditableEventResponse[]> {
        const events = await Promise.all(
            folder.children.map(async (file) => {
                if (file instanceof TFile) {
                    return await this.getEventsInFile(file);
                } else if (file instanceof TFolder) {
                    return await this.getEventsInFolderRecursive(file);
                } else {
                    return [];
                }
            })
        );
        return events.flat();
    }

    async getEvents(): Promise<EditableEventResponse[]> {
        const eventFolder = this.app.getAbstractFileByPath(this.directory);
        if (!eventFolder) {
            throw new Error(`Cannot get folder ${this.directory}`);
        }
        if (!(eventFolder instanceof TFolder)) {
            throw new Error(`${eventFolder} is not a directory.`);
        }
        const events: EditableEventResponse[] = [];
        for (const file of eventFolder.children) {
            if (file instanceof TFile) {
                const results = await this.getEventsInFile(file);
                events.push(...results);
            }
        }
        return events;
    }

    /**
     * Write a new event out to its own note.
     *
     * Two events on the same day with the same title are legitimate, so a name
     * that is already taken picks up a `_2`, `_3` suffix rather than refusing
     * the create.
     */
    /**
     * Work out which of this calendar's notes have filenames that disagree
     * with their frontmatter.
     *
     * Reads only, and only the notes `getEvents` would read. Nothing here
     * renames anything: the caller decides whether to report the plan or apply
     * it.
     */
    async planFilenameRepair(): Promise<CalendarRepairPlan> {
        const eventFolder = this.app.getAbstractFileByPath(this.directory);
        if (!eventFolder) {
            throw new Error(`Cannot get folder ${this.directory}`);
        }
        if (!(eventFolder instanceof TFolder)) {
            throw new Error(`${eventFolder} is not a directory.`);
        }
        const notes: PlannableNote[] = [];
        for (const file of eventFolder.children) {
            if (!(file instanceof TFile)) {
                continue;
            }
            notes.push({
                path: file.path,
                basename: file.basename,
                event: validateEvent(this.app.getMetadata(file)?.frontmatter),
            });
        }
        return planRepairs(this.directory, notes, this.dateFormat);
    }

    /**
     * Perform the renames in a plan.
     *
     * Renames go through the adapter's `rename`, which is Obsidian's
     * `fileManager.renameFile`, so inbound `[[wikilinks]]` are rewritten as
     * each note moves. Renaming these files any other way would break links
     * silently, which is the failure this whole slice is trying to avoid.
     *
     * Each rename is re-checked against the vault immediately before it runs.
     * A plan is shown to the user and then applied on their say-so, and the
     * vault may have moved underneath it in between.
     *
     * @returns The renames that were actually performed.
     */
    async applyFilenameRepair(
        plan: CalendarRepairPlan
    ): Promise<PlannedRename[]> {
        const applied: PlannedRename[] = [];
        for (const rename of plan.renames) {
            const file = this.app.getFileByPath(rename.from);
            if (!file) {
                throw new Error(
                    `Cannot rename ${rename.from}: it no longer exists. Re-run the repair to plan against the vault as it is now.`
                );
            }
            if (this.app.getAbstractFileByPath(rename.to)) {
                throw new Error(
                    `Cannot rename ${rename.from} to ${rename.to}: something is already there. Re-run the repair to plan against the vault as it is now.`
                );
            }
            await this.app.rename(file, rename.to);
            applied.push(rename);
        }
        return applied;
    }

    async createEvent(event: FerryEvent): Promise<EventLocation> {
        const basename = this.freeBasenameFor(this.directory, event);
        const path = `${this.directory}/${basename}.md`;
        const file = await this.app.create(
            path,
            newFrontmatter(serializeEvent(event))
        );
        return { file, lineNumber: undefined };
    }

    /**
     * Where a note should live once its event has been edited.
     *
     * Frontmatter is authoritative, so changing an event's date or title
     * changes the filename derived from it. A name that already carries a
     * collision suffix is left alone: `_2` is a name the plugin assigned
     * itself, not drift to be corrected.
     */
    getNewLocation(
        location: EventPathLocation,
        event: FerryEvent
    ): EventLocation {
        const { path, lineNumber } = location;
        if (lineNumber !== undefined) {
            throw new Error("Note calendar cannot handle inline events.");
        }
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(
                `File ${path} either doesn't exist or is a folder.`
            );
        }

        // Every file in a vault sits inside a folder, so a null parent means
        // the file has been detached and the caller is working from stale
        // state. Fail rather than writing the renamed note to the vault root.
        if (!file.parent) {
            throw new Error(`File ${path} has no parent folder.`);
        }

        const folder = file.parent.path;
        const expected = basenameForEvent(event, this.dateFormat);
        const basename = basenameMatchesEvent(file.basename, expected)
            ? file.basename
            : this.freeBasenameFor(folder, event, file.path);

        return {
            file: { path: `${folder}/${basename}.md` },
            lineNumber: undefined,
        };
    }

    async modifyEvent(
        location: EventPathLocation,
        event: FerryEvent,
        updateCacheWithLocation: (loc: EventLocation) => void
    ): Promise<void> {
        const { path } = location;
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(
                `File ${path} either doesn't exist or is a folder.`
            );
        }
        const newLocation = this.getNewLocation(location, event);

        updateCacheWithLocation(newLocation);

        if (file.path !== newLocation.file.path) {
            await this.app.rename(file, newLocation.file.path);
        }
        // Writing the event also retires the keys it has replaced, so a note
        // never ends up carrying two descriptions of the same event.
        const fields = serializeEvent(event);
        await this.app.rewrite(file, (page) =>
            modifyFrontmatterString(page, fields, replacedKeys(fields))
        );

        return;
    }

    async move(
        fromLocation: EventPathLocation,
        toCalendar: EditableCalendar,
        updateCacheWithLocation: (loc: EventLocation) => void
    ): Promise<void> {
        const { path, lineNumber } = fromLocation;
        if (lineNumber !== undefined) {
            throw new Error("Note calendar cannot handle inline events.");
        }
        if (!(toCalendar instanceof FullNoteCalendar)) {
            throw new Error(
                `Event cannot be moved to a note calendar from a calendar of type ${toCalendar.type}.`
            );
        }
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(`File ${path} not found.`);
        }
        // The name is already correct for the event; it just has to be free in
        // the folder it is landing in, where an unrelated note may hold it.
        const destDir = toCalendar.directory;
        const basename = disambiguate(file.basename, (name) =>
            this.isTaken(destDir, name)
        );
        const newPath = `${destDir}/${basename}.md`;
        updateCacheWithLocation({
            file: { path: newPath },
            lineNumber: undefined,
        });
        await this.app.rename(file, newPath);
    }

    deleteEvent({ path, lineNumber }: EventPathLocation): Promise<void> {
        if (lineNumber !== undefined) {
            throw new Error("Note calendar cannot handle inline events.");
        }
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(`File ${path} not found.`);
        }
        return this.app.delete(file);
    }
}
