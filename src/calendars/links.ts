/**
 * Wikilinks, as the plugin writes and reads them.
 *
 * One field needs them: `recurringParent`, which points an override note at the
 * master whose occurrence it replaces. A link rather than a path because
 * Obsidian *maintains* links — it rewrites them when the target is renamed, and
 * this plugin renames event notes constantly, whenever a date or title changes
 * and whenever the repair command runs. A stored path would be stale the first
 * time the master's DTSTART moved; a stored link is updated for us.
 *
 * This module is free of Obsidian and DOM references so it can be unit-tested
 * directly. Resolving a link against the vault is somebody else's job — see
 * `resolveLink` on the adapter.
 */

/** Extension every note carries, stripped from a link target. */
const MARKDOWN_EXTENSION = ".md";

/**
 * Write a link to a note at a given path.
 *
 * The **full vault path** goes in the link, not the bare filename that
 * PLANNING §3.2 shows by way of illustration. A basename is prettier and is
 * what Obsidian itself would generate under "shortest path when possible", but
 * it is not always unambiguous here: two calendars can each hold a
 * `_recurring/20260317_Gym.md`, and an override sitting in `CALENDARS/SOCIAL/`
 * is in neither master's folder, so the shortest form could resolve to the
 * wrong series. Attaching an override to another calendar's rule is a quiet,
 * durable kind of wrong, and the path costs only some width in a file nobody
 * reads by hand.
 *
 * This is only what the plugin *writes*. Obsidian may shorten the link when it
 * rewrites it on a rename, and that is fine — a link Obsidian rewrote still
 * resolves to the file it rewrote it for.
 *
 * @param path Vault path of the target note, with or without `.md`.
 * @returns The link, `[[like/this]]`.
 */
export function formatWikilink(path: string): string {
    const target = path.endsWith(MARKDOWN_EXTENSION)
        ? path.slice(0, -MARKDOWN_EXTENSION.length)
        : path;
    return `[[${target}]]`;
}

/**
 * Read the target out of a wikilink.
 *
 * Handles the forms a hand-editing user may leave behind as well as the one the
 * plugin writes: an alias after `|`, a heading or block reference after `#`,
 * and surrounding whitespace. What comes back is a *linkpath* — the thing
 * Obsidian resolves against the vault — not a path, because a link written by
 * hand or shortened by Obsidian is very often not one.
 *
 * @param link The field's value, expected as `[[target]]`.
 * @returns The linkpath, or null if the value is not a wikilink at all. Null is
 * a real answer rather than an error: the field is hand-editable, and a caller
 * that cannot resolve a parent needs to say so about that specific note rather
 * than fail the whole load.
 */
export function parseWikilink(link: string): string | null {
    const trimmed = link.trim();
    if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) {
        return null;
    }
    const inner = trimmed.slice(2, -2);
    // Alias first: a `#` inside the display half is part of the text, not a
    // heading reference on the target.
    const target = inner.split("|")[0].split("#")[0].trim();
    return target.length > 0 ? target : null;
}

/**
 * Recover a wikilink from the value YAML produced for an unquoted one.
 *
 * Until PLANNING §13.2 was fixed, `formatWikilink`'s output went into
 * frontmatter unquoted, and `[[path/to/note]]` is a flow sequence nested in a
 * flow sequence to any YAML parser. So Obsidian handed back
 * `[["path/to/note"]]` where the schema expects a string, the parse failed, and
 * the note stopped being an event entirely — silently, since a note that yields
 * no events is indistinguishable from a note that is not an event.
 *
 * Fixing the writer does not fix those notes: their text does not change until
 * something saves them. So the reader accepts the shape too and normalises it
 * back, exactly as `parseEvent` accepts the inherited `daysOfWeek` recurrence
 * shape and converts it. Read tolerantly, write one way. An affected note heals
 * on its next save and needs no migration command.
 *
 * @param value The raw frontmatter value, of whatever type YAML made it.
 * @returns The wikilink as a string, or null if the value is neither a string
 * nor the nested-sequence form — in which case the caller's own validation
 * should reject it and say so.
 */
export function wikilinkFromYaml(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }
    // Exactly one element at each level. A comma inside the link would have
    // split it further, but §4.3 puts no commas in the filenames this points
    // at, so a wider shape is more likely to be something else entirely.
    if (!Array.isArray(value) || value.length !== 1) {
        return null;
    }
    const inner = value[0];
    if (!Array.isArray(inner) || inner.length !== 1) {
        return null;
    }
    return typeof inner[0] === "string" ? `[[${inner[0]}]]` : null;
}
