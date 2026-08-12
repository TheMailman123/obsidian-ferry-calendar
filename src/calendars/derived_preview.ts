import { App, TFile, TFolder } from "obsidian";
import { ObsidianIO } from "../ObsidianAdapter";
import DerivedCalendar from "./DerivedCalendar";
import { DerivedMapping, MappingReport } from "./parsing/derived";

/*
 * Dry-running a derived mapping before it becomes a calendar.
 *
 * This lives in `calendars` rather than `ui` on purpose: the architecture
 * invariant keeps the ui layer from reaching into Calendar subclasses, and the
 * settings form needs an answer that only a calendar can give. The form calls
 * these two functions and knows nothing about how they arrive at it.
 */

/** The parts of a half-filled-in derived source a preview can work from. */
export type DerivedPreviewInput = {
    name?: string;
    directory?: string;
    recursive?: boolean;
    color?: string;
    mapping: DerivedMapping;
};

/**
 * Frontmatter property names present in a folder.
 *
 * Offered to the mapping form so a property can be picked rather than typed
 * from memory: the notes are the authority on what their properties are
 * called, and a name that matches nothing produces an empty calendar with no
 * hint as to why.
 */
export function listPropertiesInDirectory(
    app: App,
    directory: string,
    recursive: boolean
): string[] {
    const folder = app.vault.getAbstractFileByPath(directory || "/");
    if (!(folder instanceof TFolder)) {
        return [];
    }

    const properties = new Set<string>();
    const visit = (f: TFolder) => {
        for (const child of f.children) {
            if (child instanceof TFile) {
                const frontmatter =
                    app.metadataCache.getFileCache(child)?.frontmatter;
                for (const key of Object.keys(frontmatter ?? {})) {
                    // Obsidian stuffs the frontmatter's source range in here;
                    // it is not a property anyone wrote.
                    if (key !== "position") {
                        properties.add(key);
                    }
                }
            } else if (child instanceof TFolder && recursive) {
                visit(child);
            }
        }
    };
    visit(folder);

    return [...properties].sort();
}

/**
 * Run a draft mapping over its folder without saving it.
 *
 * Builds the very calendar the draft describes and asks what it would produce,
 * so the counts shown before saving cannot drift from what loads afterwards.
 *
 * @returns a report, or the reason there isn't one yet
 */
export function previewDerivedSource(
    app: App,
    draft: DerivedPreviewInput
): { report: MappingReport | null; error: string | null } {
    if (!draft.directory || !draft.mapping.start) {
        return {
            report: null,
            error: "Choose a directory and a start date property to see what this mapping would produce.",
        };
    }

    try {
        const calendar = new DerivedCalendar(
            new ObsidianIO(app),
            draft.color ?? "",
            draft.name || "Preview",
            draft.directory,
            draft.recursive ?? false,
            draft.mapping
        );
        return { report: calendar.previewMapping(), error: null };
    } catch (e) {
        return {
            report: null,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
