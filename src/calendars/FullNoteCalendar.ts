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
    folderForEvent,
    RECURRING_DIR,
} from "./filenames";
import {
    CalendarRepairPlan,
    PlannableNote,
    PlannedRename,
    planRepairs,
} from "./filename_repair";
import { modifyFrontmatterString, newFrontmatter } from "./frontmatter";
import { formatWikilink, parseWikilink } from "./links";

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
     * Working-calendar notes live directly in the calendar's own folder, or in
     * `_recurring/` immediately below it.
     *
     * Narrower than the base implementation on purpose, and it has to be: this
     * has to agree exactly with what `getEvents` reads, or a note would be
     * invisible on load and yet parsed as an ordinary event the moment it was
     * edited — on the calendar or not depending on which code path last ran.
     *
     * `_recurring/` holds the masters, which are events like any other and are
     * read as such. Nothing deeper is: a nested folder is somebody's own
     * arrangement of their vault, and claiming it would mean the plugin
     * renaming notes it was never asked to manage.
     */
    containsPath(path: string): boolean {
        if (!super.containsPath(path)) {
            return false;
        }
        const relative =
            this.directory === ""
                ? path
                : path.slice(this.directory.length + 1);
        const separator = relative.indexOf("/");
        if (separator === -1) {
            return true;
        }
        return (
            relative.slice(0, separator) === RECURRING_DIR &&
            !relative.slice(separator + 1).includes("/")
        );
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

    /**
     * Read the events out of a folder's own notes.
     *
     * One level only. Subfolders are somebody else's arrangement of their
     * vault, apart from `_recurring/`, which `getEvents` asks for by name.
     */
    private async getEventsInFolder(
        folder: TFolder
    ): Promise<EditableEventResponse[]> {
        const events: EditableEventResponse[] = [];
        for (const file of folder.children) {
            if (file instanceof TFile) {
                events.push(...(await this.getEventsInFile(file)));
            }
        }
        return events;
    }

    /**
     * Every event in the calendar: the dated notes, and the recurrence masters
     * in `_recurring/`.
     *
     * A master is one event, not one per occurrence — the rule is expanded at
     * render time across the range on screen and nowhere else, which is what
     * makes "every Tuesday, forever" cost the same as any other note.
     *
     * The folder is read for whatever is in it rather than for recurring events
     * specifically. A single event filed there is misplaced, not invalid, and
     * editing it moves it back out to where its date belongs.
     */
    async getEvents(): Promise<EditableEventResponse[]> {
        const eventFolder = this.app.getAbstractFileByPath(this.directory);
        if (!eventFolder) {
            throw new Error(`Cannot get folder ${this.directory}`);
        }
        if (!(eventFolder instanceof TFolder)) {
            throw new Error(`${eventFolder} is not a directory.`);
        }
        const events = await this.getEventsInFolder(eventFolder);

        const masters = this.app.getAbstractFileByPath(
            `${this.directory}/${RECURRING_DIR}`
        );
        if (masters instanceof TFolder) {
            events.push(...(await this.getEventsInFolder(masters)));
        }
        return events;
    }

    /**
     * Work out which of this calendar's notes have filenames that disagree
     * with their frontmatter.
     *
     * Reads only, and only the notes `getEvents` would read — which now means
     * `_recurring/` as well, so a master whose DTSTART was hand-edited is
     * reported like any other drifting note. Nothing here renames anything: the
     * caller decides whether to report the plan or apply it.
     */
    /**
     * The notes directly in a folder, as the repair planner needs to see them.
     *
     * Notes that are not events are included rather than skipped: the plugin
     * has no opinion about their names, but those names are still occupied and
     * a rename must not land on one.
     */
    private plannableNotesIn(folder: TFolder): PlannableNote[] {
        const notes: PlannableNote[] = [];
        for (const file of folder.children) {
            if (!(file instanceof TFile)) {
                continue;
            }
            notes.push({
                path: file.path,
                basename: file.basename,
                event: validateEvent(this.app.getMetadata(file)?.frontmatter),
            });
        }
        return notes;
    }

    async planFilenameRepair(): Promise<CalendarRepairPlan> {
        const eventFolder = this.app.getAbstractFileByPath(this.directory);
        if (!eventFolder) {
            throw new Error(`Cannot get folder ${this.directory}`);
        }
        if (!(eventFolder instanceof TFolder)) {
            throw new Error(`${eventFolder} is not a directory.`);
        }
        const notes = this.plannableNotesIn(eventFolder);

        const masters = this.app.getAbstractFileByPath(
            `${this.directory}/${RECURRING_DIR}`
        );
        if (masters instanceof TFolder) {
            notes.push(...this.plannableNotesIn(masters));
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

    /**
     * Make sure a folder exists before a note is written into it.
     *
     * `_recurring/` is created when the first master needs it rather than when
     * the calendar is configured: a calendar that never has a recurring event
     * should not grow an empty folder in someone's vault.
     *
     * @throws If a file is sitting where the folder needs to be. Writing the
     * master somewhere else instead would put it where `getEvents` reads
     * ordinary events, and it would render on the day of its DTSTART only.
     */
    private async ensureFolder(path: string): Promise<void> {
        const existing = this.app.getAbstractFileByPath(path);
        if (existing instanceof TFolder) {
            return;
        }
        if (existing) {
            throw new Error(
                `Cannot create the folder ${path}: a file is already there.`
            );
        }
        await this.app.createFolder(path);
    }

    /**
     * Write a new event out to its own note.
     *
     * A recurring event's note is a master and goes to `_recurring/`, which is
     * created here if this is the first one. Two events on the same day with
     * the same title are legitimate, so a name that is already taken picks up a
     * `_2`, `_3` suffix rather than refusing the create.
     */
    async createEvent(event: FerryEvent): Promise<EventLocation> {
        const folder = folderForEvent(this.directory, event);
        await this.ensureFolder(folder);
        const basename = this.freeBasenameFor(folder, event);
        const path = `${folder}/${basename}.md`;
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
     *
     * The folder is derived the same way, so an event that becomes recurring —
     * or stops being — moves between the calendar's folder and `_recurring/`.
     * A note crossing folders gives up any collision suffix it was carrying and
     * takes whatever name is free where it lands, since the suffix answers a
     * question about the folder it is leaving.
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

        const folder = folderForEvent(this.directory, event);
        const staying = folder === file.parent.path;
        const expected = basenameForEvent(event, this.dateFormat);
        const basename =
            staying && basenameMatchesEvent(file.basename, expected)
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
            // The move may be into `_recurring/`, which nothing has needed
            // until now if this is the calendar's first recurring event.
            await this.ensureFolder(folderForEvent(this.directory, event));
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
        // A master has to land in the destination's `_recurring/`, not beside
        // its dated notes, so the event is read back out of the note to find
        // out which it is. A note that no longer parses keeps the folder it
        // would have had before, which is where it already lives.
        const [master] = await this.getEventsInFile(file);
        const destDir = master
            ? folderForEvent(toCalendar.directory, master[0])
            : toCalendar.directory;
        await this.ensureFolder(destDir);
        // The name is already correct for the event; it just has to be free in
        // the folder it is landing in, where an unrelated note may hold it.
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

    /**
     * A link pointing at one of this calendar's notes.
     *
     * Used for an override's `recurringParent`. It is a link rather than a path
     * so that Obsidian maintains it: this plugin renames event notes whenever a
     * date or title changes, and a stored path would be stale the first time
     * the master's DTSTART moved.
     *
     * @param path Vault path of the note to point at.
     */
    linkTo(path: string): string {
        return formatWikilink(path);
    }

    /**
     * Follow a link stored in one of this calendar's notes.
     *
     * @param link Field value, expected as `[[target]]`.
     * @param fromPath Path of the note holding the link, since resolution is
     * relative to it just as it is for a link in a note's body.
     * @returns Path of the note it points at, or null if the value is not a
     * link or resolves to nothing. Null is an answer rather than an error: the
     * field is hand-editable, and one unresolvable parent should not fail the
     * load of a whole calendar.
     */
    resolveLink(link: string, fromPath: string): string | null {
        const linkpath = parseWikilink(link);
        if (linkpath === null) {
            return null;
        }
        return this.app.resolveLink(linkpath, fromPath)?.path ?? null;
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
