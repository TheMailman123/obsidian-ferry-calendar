/**
 * The tags the plugin writes onto an event note when it creates one.
 *
 * The requirement is one vault's convention — `#INVISIBLE`, so event notes stay
 * out of that vault's other views — and a convention of one vault is exactly
 * what PLANNING §12 keeps out of the plugin. So the tag names are a setting and
 * this module only knows how to read a list of them and write it back; nothing
 * here knows what any particular tag means.
 *
 * They go in frontmatter rather than inline in the body: the plugin already
 * owns a note's frontmatter and owns no part of its body, and Obsidian treats
 * the two as the same tag anyway.
 */

/**
 * Read a tag list out of the settings text field.
 *
 * Accepts what someone would actually type — `#INVISIBLE, #EVENT`, or the same
 * without the hashes, or separated by spaces — because the alternative is a
 * field that silently does nothing when it is filled in the obvious way.
 *
 * @param input The raw text field contents.
 * @returns Tag names without their leading `#`, in the order given, deduped.
 */
export function parseTagList(input: string): string[] {
    const seen = new Set<string>();
    for (const token of input.split(/[\s,]+/)) {
        const tag = token.replace(/^#+/, "").trim();
        if (tag) {
            seen.add(tag);
        }
    }
    return [...seen];
}

/**
 * Render a stored tag list back into the settings field.
 *
 * The `#` is put back on: it is how a tag is written everywhere else in
 * Obsidian, and a field that reads back differently to how it was typed looks
 * like the setting did not take.
 *
 * @param tags Tag names, without their leading `#`.
 */
export function formatTagList(tags: string[]): string {
    return tags.map((tag) => `#${tag}`).join(", ");
}

/**
 * The `tags:` entry for a note being created, or nothing.
 *
 * Written on create only. `modifyFrontmatterString` replaces a key whole — the
 * unit it works in is an entry — so writing `tags:` on every save would destroy
 * whatever else had been added to that key since. Create needs no merge at all,
 * and covers what was asked for.
 *
 * @param tags The configured tag names, without their leading `#`.
 * @returns A frontmatter fragment to spread, empty when nothing is configured
 * so that no `tags:` line is written at all.
 */
export function tagsFrontmatter(tags: string[]): { tags?: string[] } {
    return tags.length > 0 ? { tags } : {};
}
