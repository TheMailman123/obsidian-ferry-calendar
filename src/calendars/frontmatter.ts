import { parseYaml } from "obsidian";
import { FerryEvent } from "../types";

/**
 * Writing an event back into the frontmatter of its note.
 *
 * Obsidian's metadata cache handles the read direction, so this module only
 * covers the write: turning an event into the YAML block at the top of a note,
 * either from scratch (`newFrontmatter`) or by editing the block already there
 * (`modifyFrontmatterString`).
 *
 * The two are deliberately different operations. A note the plugin creates has
 * only the fields the plugin knows about, so its frontmatter can be generated
 * outright. A note the *user* has been editing may carry anything else besides
 * — tags, aliases, fields belonging to other plugins — and modifying it has to
 * leave all of that alone, in place and in order. That is why the modify path
 * walks the existing block rather than regenerating it: the plugin owns the
 * keys of an event, not the file.
 */

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

/**
 * Replace a page's frontmatter, keeping everything below it.
 *
 * @param page Contents of a markdown file.
 * @param newFrontmatter Replacement frontmatter body, without the `---` fences
 * and ending in a newline.
 */
function replaceFrontmatter(page: string, newFrontmatter: string): string {
    return `---\n${newFrontmatter}---${extractPageContents(page)}`;
}

/** A value that can appear on the right-hand side of a frontmatter key. */
export type PrintableAtom = Array<number | string> | number | string | boolean;

/**
 * Render one frontmatter value.
 *
 * Arrays render in YAML's inline flow style, which keeps an event to one line
 * per field and so keeps the modify path — which works line by line — able to
 * find and replace a field it has already written.
 */
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

/** Render one `key: value` frontmatter line. */
function stringifyYamlLine(
    k: string | number | symbol,
    v: PrintableAtom
): string {
    return `${String(k)}: ${stringifyYamlAtom(v)}`;
}

/**
 * Generate the frontmatter block for a note the plugin is creating.
 *
 * @param fields Event fields to write. Undefined values are omitted rather
 * than written as empty keys, so an event without an end time produces no
 * `endTime` line at all.
 * @returns A complete frontmatter block, fences included.
 */
export function newFrontmatter(fields: Partial<FerryEvent>): string {
    return (
        "---\n" +
        Object.entries(fields)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => stringifyYamlLine(k, v))
            .join("\n") +
        "\n---\n"
    );
}

/**
 * Apply a set of field changes to the frontmatter of an existing note.
 *
 * Keys already present are rewritten where they stand, so the user's ordering
 * survives; keys that are new to the note are appended. Anything the
 * modifications do not mention is passed through untouched — see the module
 * docstring for why that matters.
 *
 * @param page Contents of the markdown file.
 * @param modifications Fields to set. Undefined values are ignored, not
 * treated as deletions.
 * @returns The page with its frontmatter updated, adding a block if the note
 * had none.
 * @throws If a frontmatter line parses to more than one key, which would mean
 * the block is not the one-field-per-line shape this function can safely edit.
 */
export function modifyFrontmatterString(
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
