import { Notice, TFile, TFolder } from "obsidian";
import { ObsidianInterface } from "../ObsidianAdapter";
import { EventResponse } from "./Calendar";
import { VaultCalendar, VaultEventResponse } from "./VaultCalendar";
import {
    DerivedMapping,
    MappingOutcome,
    mapNoteToEvent,
    MappingReport,
    summarizeOutcomes,
} from "./parsing/derived";

/**
 * A read-only projection of notes that exist for their own reasons.
 *
 * Extends VaultCalendar rather than EditableCalendar, and that is the whole of
 * the read-only enforcement: there is no create, delete or modify method to
 * call, so nothing in the plugin can write to a source note even by mistake.
 * The cache reports these events as non-editable, which switches off drag and
 * resize in the view for free.
 *
 * A note in one of these folders is a record that has dates on it, not an
 * event. "Reschedule" is meaningless for it, and a stray drag silently
 * rewriting someone's frontmatter is the worst failure this plugin could have.
 */
export default class DerivedCalendar extends VaultCalendar {
    private app: ObsidianInterface;
    private _name: string;
    private _directory: string;
    private recursive: boolean;
    private mapping: DerivedMapping;

    constructor(
        app: ObsidianInterface,
        color: string,
        name: string,
        directory: string,
        recursive: boolean,
        mapping: DerivedMapping
    ) {
        super(color);
        this.app = app;
        this._name = name;
        this._directory = normalizeDirectory(directory);
        this.recursive = recursive;
        this.mapping = mapping;
    }

    get type(): "derived" {
        return "derived";
    }

    /**
     * Directory *and* name, because one folder can carry several mappings.
     *
     * Two mappings over the same notes — one projecting a date yearly, another
     * spanning a pair of dates — are separate calendars with their own colour
     * and their own row in the key, so the directory alone cannot identify one.
     */
    get identifier(): string {
        return `${this._directory}::${this._name}`;
    }

    get name(): string {
        return this._name;
    }

    get directory(): string {
        return this._directory;
    }

    /**
     * Whether this calendar reads the given path.
     *
     * Stricter than the inherited prefix test in two ways it needs to be: a
     * non-recursive calendar ignores subfolders, and "RECORDS" must not claim
     * "RECORDS_ARCHIVE/note.md".
     */
    containsPath(path: string): boolean {
        if (this._directory === "") {
            // Vault root: everything is in it, but only the top level counts
            // when the calendar is not recursive.
            return this.recursive || !path.includes("/");
        }
        if (!path.startsWith(`${this._directory}/`)) {
            return false;
        }
        const relative = path.slice(this._directory.length + 1);
        return this.recursive || !relative.includes("/");
    }

    /**
     * Project a single note.
     *
     * A note the mapping cannot describe yields no event rather than a wrong
     * one. The reason is logged: a silent gap in a folder of a hundred notes is
     * undebuggable, which is the whole argument for the mapping preview.
     */
    async getEventsInFile(file: TFile): Promise<VaultEventResponse[]> {
        const outcome = this.mapNote(file);
        if (outcome.status !== "event") {
            return [];
        }
        return [[outcome.event, { file, lineNumber: undefined }]];
    }

    private mapNote(file: TFile): MappingOutcome {
        const frontmatter = this.app.getMetadata(file)?.frontmatter;
        const outcome = mapNoteToEvent(
            frontmatter,
            { basename: file.basename, path: file.path },
            this.mapping
        );
        if (outcome.status === "error") {
            console.warn(
                `Ferry Calendar: '${this.name}' could not map ${file.path}: ${outcome.reason}`
            );
        }
        return outcome;
    }

    async getEvents(): Promise<EventResponse[]> {
        // The root folder is "" for prefix comparison but "/" to look up.
        const folder = this.app.getAbstractFileByPath(this._directory || "/");
        if (!folder) {
            throw new Error(
                `Calendar '${this.name}' points at '${this._directory}', which does not exist.`
            );
        }
        if (!(folder instanceof TFolder)) {
            throw new Error(
                `Calendar '${this.name}' points at '${this._directory}', which is a file, not a directory.`
            );
        }

        const files = this.collectFiles(folder);
        const outcomes = files.map((file) => ({
            path: file.path,
            file,
            outcome: this.mapNote(file),
        }));

        this.report(summarizeOutcomes(outcomes));

        return outcomes.flatMap(({ file, outcome }): EventResponse[] =>
            outcome.status === "event"
                ? [[outcome.event, { file, lineNumber: undefined }]]
                : []
        );
    }

    /** Markdown files this calendar reads, honouring `recursive`. */
    private collectFiles(folder: TFolder): TFile[] {
        const files: TFile[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile) {
                files.push(child);
            } else if (child instanceof TFolder && this.recursive) {
                files.push(...this.collectFiles(child));
            }
        }
        return files;
    }

    /**
     * Tell the user what the mapping made of the folder.
     *
     * Skips are expected — not every note in a folder has a date — so they only
     * reach the console. Errors mean the mapping and the notes disagree, which
     * the user has to know about without going looking for it.
     */
    private report(report: MappingReport): void {
        console.debug(`Ferry Calendar: '${this.name}' mapping report`, report);
        if (report.errors > 0) {
            new Notice(
                `Ferry Calendar: ${report.errors} note(s) in '${this.name}' could not be read as events. Check the console, or reopen the calendar's settings to see why.`
            );
        }
    }
}

/**
 * Normalize a folder path for prefix comparison.
 *
 * Obsidian gives the vault root the path "/" while every other folder is
 * unrooted, so the root is flattened to "" and any trailing slash removed.
 */
function normalizeDirectory(directory: string): string {
    const trimmed = directory.trim().replace(/\/+$/, "");
    return trimmed === "/" ? "" : trimmed;
}
