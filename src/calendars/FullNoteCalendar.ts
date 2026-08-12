import { TFile, TFolder, parseYaml } from "obsidian";
import { EventPathLocation } from "../core/EventStore";
import { ObsidianInterface } from "../ObsidianAdapter";
import { FerryEvent, EventLocation, validateEvent } from "../types";
import { EditableCalendar, EditableEventResponse } from "./EditableCalendar";
import {
    basenameForEvent,
    basenameMatchesEvent,
    DEFAULT_FILENAME_DATE_FORMAT,
    disambiguate,
    FilenameDateFormat,
} from "./filenames";

const FRONTMATTER_SEPARATOR = "---";

/**
 * @param page Contents of a markdown file.
 * @returns Whether or not this page has a frontmatter section.
 */
function hasFrontmatter(page: string): boolean {
    return (
        page.indexOf(FRONTMATTER_SEPARATOR) === 0 &&
        page.slice(3).indexOf(FRONTMATTER_SEPARATOR) !== -1
    );
}

/**
 * Return only frontmatter from a page.
 * @param page Contents of a markdown file.
 * @returns Frontmatter section of a page.
 */
function extractFrontmatter(page: string): string | null {
    if (hasFrontmatter(page)) {
        return page.split(FRONTMATTER_SEPARATOR)[1];
    }
    return null;
}

/**
 * Remove frontmatter from a page.
 * @param page Contents of markdown file.
 * @returns Contents of a page without frontmatter.
 */
function extractPageContents(page: string): string {
    if (hasFrontmatter(page)) {
        // Frontmatter lives between the first two --- linebreaks.
        return page.split("---").slice(2).join("---");
    } else {
        return page;
    }
}

function replaceFrontmatter(page: string, newFrontmatter: string): string {
    return `---\n${newFrontmatter}---${extractPageContents(page)}`;
}

type PrintableAtom = Array<number | string> | number | string | boolean;

function stringifyYamlAtom(v: PrintableAtom): string {
    let result = "";
    if (Array.isArray(v)) {
        result += "[";
        result += v.map(stringifyYamlAtom).join(",");
        result += "]";
    } else {
        result += `${v}`;
    }
    return result;
}

function stringifyYamlLine(
    k: string | number | symbol,
    v: PrintableAtom
): string {
    return `${String(k)}: ${stringifyYamlAtom(v)}`;
}

function newFrontmatter(fields: Partial<FerryEvent>): string {
    return (
        "---\n" +
        Object.entries(fields)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => stringifyYamlLine(k, v))
            .join("\n") +
        "\n---\n"
    );
}

function modifyFrontmatterString(
    page: string,
    modifications: Partial<FerryEvent>
): string {
    const frontmatter = extractFrontmatter(page)?.split("\n");
    let newFrontmatter: string[] = [];
    if (!frontmatter) {
        newFrontmatter = Object.entries(modifications)
            .filter(([k, v]) => v !== undefined)
            .map(([k, v]) => stringifyYamlLine(k, v));
        page = "\n" + page;
    } else {
        const linesAdded: Set<string | number | symbol> = new Set();
        // Modify rows in-place.
        for (let i = 0; i < frontmatter.length; i++) {
            const line: string = frontmatter[i];
            const obj: Record<any, any> | null = parseYaml(line);
            if (!obj) {
                continue;
            }

            const keys = Object.keys(obj) as [keyof FerryEvent];
            if (keys.length !== 1) {
                throw new Error("One YAML line parsed to multiple keys.");
            }
            const key = keys[0];
            linesAdded.add(key);
            const newVal: PrintableAtom | undefined = modifications[key];
            if (newVal !== undefined) {
                newFrontmatter.push(stringifyYamlLine(key, newVal));
            } else {
                // Just push the old line if we don't have a modification.
                newFrontmatter.push(line);
            }
        }

        // Add all rows that were not originally in the frontmatter.
        newFrontmatter.push(
            ...(Object.keys(modifications) as [keyof FerryEvent])
                .filter((k) => !linesAdded.has(k))
                .filter((k) => modifications[k] !== undefined)
                .map((k) =>
                    stringifyYamlLine(k, modifications[k] as PrintableAtom)
                )
        );
    }
    return replaceFrontmatter(page, newFrontmatter.join("\n") + "\n");
}

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
    async createEvent(event: FerryEvent): Promise<EventLocation> {
        const basename = this.freeBasenameFor(this.directory, event);
        const path = `${this.directory}/${basename}.md`;
        const file = await this.app.create(path, newFrontmatter(event));
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
        await this.app.rewrite(file, (page) =>
            modifyFrontmatterString(page, event)
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
