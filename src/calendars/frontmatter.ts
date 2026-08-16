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
export type PrintableAtom =
    | Array<number | string>
    | number
    | string
    | boolean
    | null
    | PrintableBlock;

/**
 * A nested mapping, written as an indented block.
 *
 * Recurrence is the reason this exists: a rule the user can read and correct by
 * hand is worth more than one they have to decode, so `recurring:` is authored
 * as a block of named fields rather than an opaque RRULE string.
 */
export type PrintableBlock = { [key: string]: PrintableAtom | undefined };

/**
 * The fields to write into an event note's frontmatter.
 *
 * A record rather than `Partial<FerryEvent>`, because the frontmatter of a note
 * is not the plugin's to define: the fields of an event are only some of the
 * keys that may be in there, and this module has to be able to name the others
 * in order to leave them alone.
 */
export type EventFrontmatter = PrintableBlock;

/** How far one level of nesting indents. Two spaces, as Obsidian itself writes. */
const INDENT = "  ";

/** Whether a value is a nested mapping rather than a scalar or a list. */
function isBlock(v: PrintableAtom): v is PrintableBlock {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Render one scalar or list frontmatter value.
 *
 * Lists render in YAML's inline flow style, which keeps them to a single line
 * and so keeps them findable by the modify path.
 */
function stringifyYamlAtom(v: Exclude<PrintableAtom, PrintableBlock>): string {
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

/**
 * Render one frontmatter entry — a key and its value.
 *
 * Scalars and lists occupy one line; a nested block occupies as many lines as
 * it has fields, which is why the unit here is an entry rather than a line.
 * Everything downstream has to treat a multi-line entry as indivisible.
 *
 * @param k Frontmatter key.
 * @param v Value to render.
 * @param depth Nesting level, controlling indentation. Callers start at 0.
 */
function stringifyYamlEntry(
    k: string | number | symbol,
    v: PrintableAtom,
    depth = 0
): string {
    const pad = INDENT.repeat(depth);
    if (isBlock(v)) {
        const fields = Object.entries(v).filter(
            ([, child]) => child !== undefined
        );
        if (fields.length === 0) {
            // A block with no fields left would otherwise render as a bare
            // `key:`, which reads back as null rather than as an empty mapping
            // — a shape the schema would then have to guess at.
            return `${pad}${String(k)}: {}`;
        }
        return [
            `${pad}${String(k)}:`,
            ...fields.map(([childKey, child]) =>
                stringifyYamlEntry(childKey, child as PrintableAtom, depth + 1)
            ),
        ].join("\n");
    }
    return `${pad}${String(k)}: ${stringifyYamlAtom(v)}`;
}

/**
 * A key in an existing frontmatter block, together with every line it spans.
 *
 * `key` is null for a line the plugin cannot interpret as `key: value` — a
 * comment, say. Those are carried through untouched rather than dropped: the
 * plugin owns the fields of an event, not the rest of the note's frontmatter.
 */
interface FrontmatterEntry {
    key: string | null;
    lines: string[];
}

/** A top-level `key:` line, capturing the key. */
const KEY_LINE = /^([^\s#][^:]*):(?:\s|$)/;

/**
 * Split an existing frontmatter block into entries.
 *
 * A line at column zero opens an entry; indented lines below it are the body of
 * a nested block and belong to that same entry. Blank lines are dropped, which
 * is what the line-based version of this code did and what keeps a round-trip
 * through the modify path from accumulating whitespace.
 *
 * @param lines Frontmatter body, already split on newlines and without its
 * `---` fences.
 */
function groupEntries(lines: string[]): FrontmatterEntry[] {
    const entries: FrontmatterEntry[] = [];
    for (const line of lines) {
        if (line.trim() === "") {
            continue;
        }
        const indented = /^\s/.test(line);
        const current = entries[entries.length - 1];
        if (indented && current !== undefined) {
            current.lines.push(line);
            continue;
        }
        const match = KEY_LINE.exec(line);
        entries.push({ key: match ? match[1] : null, lines: [line] });
    }
    return entries;
}

/**
 * Generate the frontmatter block for a note the plugin is creating.
 *
 * @param fields Event fields to write. Undefined values are omitted rather
 * than written as empty keys, so an event without an end time produces no
 * `endTime` line at all.
 * @returns A complete frontmatter block, fences included.
 */
export function newFrontmatter(fields: EventFrontmatter): string {
    return (
        "---\n" +
        Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => stringifyYamlEntry(k, v as PrintableAtom))
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
 * A key whose value is a nested block is replaced whole: the replacement is
 * written in this module's own indentation, so hand-authored spacing survives
 * only for as long as the field itself goes unedited.
 *
 * Deleting a key is a separate argument rather than a value, because there is
 * no value that could mean it: `undefined` has to keep meaning "this event does
 * not have that field, leave the note's copy alone", or every write would strip
 * whatever the schema does not model. Deletion is for the case where the plugin
 * knows a key is obsolete — the inherited `daysOfWeek` shape, once its event has
 * been rewritten as a `recurring:` block — and leaving both on disk would give
 * the note two answers to the same question.
 *
 * @param page Contents of the markdown file.
 * @param modifications Fields to set. Undefined values are ignored, not
 * treated as deletions.
 * @param remove Keys to drop from the note entirely, along with every line they
 * span. A key that is not there is not an error; a key that is also being set
 * is.
 * @returns The page with its frontmatter updated, adding a block if the note
 * had none.
 * @throws If a key appears in both `modifications` and `remove`, which is a
 * caller that has not decided what it wants.
 */
export function modifyFrontmatterString(
    page: string,
    modifications: EventFrontmatter,
    remove: readonly string[] = []
): string {
    const fields = modifications;
    const contradictory = remove.filter((k) => fields[k] !== undefined);
    if (contradictory.length > 0) {
        throw new Error(
            `Frontmatter keys ${contradictory.join(
                ", "
            )} are being both written and removed.`
        );
    }
    const dropped = new Set(remove);
    const frontmatter = extractFrontmatter(page)?.split("\n");
    let newFrontmatter: string[] = [];
    if (!frontmatter) {
        newFrontmatter = Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => stringifyYamlEntry(k, v as PrintableAtom));
        page = "\n" + page;
    } else {
        const written: Set<string> = new Set();
        // Modify entries in place.
        for (const entry of groupEntries(frontmatter)) {
            if (entry.key === null) {
                newFrontmatter.push(...entry.lines);
                continue;
            }
            if (dropped.has(entry.key)) {
                // Every line of the entry goes, which for a nested block is the
                // block and its whole body.
                continue;
            }
            written.add(entry.key);
            const newVal = fields[entry.key];
            if (newVal !== undefined) {
                newFrontmatter.push(stringifyYamlEntry(entry.key, newVal));
            } else {
                // Nothing to say about this key, so the note keeps what it had
                // — every line of it, since the entry may be a nested block.
                newFrontmatter.push(...entry.lines);
            }
        }

        // Add all fields that were not originally in the frontmatter.
        newFrontmatter.push(
            ...Object.keys(fields)
                .filter((k) => !written.has(k))
                .filter((k) => fields[k] !== undefined)
                .map((k) => stringifyYamlEntry(k, fields[k] as PrintableAtom))
        );
    }
    return replaceFrontmatter(page, newFrontmatter.join("\n") + "\n");
}
