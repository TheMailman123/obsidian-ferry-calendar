/**
 * Reading and writing one named section of a note's body.
 *
 * The description field writes prose, and prose with paragraphs belongs in a
 * note's body rather than in its YAML — so the plugin, which until now owned a
 * note's frontmatter and no part of its body, has to own one section of it.
 *
 * The rule is the same one `frontmatter.ts` follows for a key: **the plugin
 * owns the section, not the file.** Everything outside it passes through
 * untouched, in place and in order, because a user's note may hold anything at
 * all and none of it was put there by this plugin.
 *
 * Free of Obsidian and of the DOM, and unit-tested directly, for the same
 * reason `frontmatter.ts` and `recurrence.ts` are.
 *
 * ## What a section is
 *
 * A heading line, and everything below it up to the next heading of equal or
 * higher level — or the end of the body. `# DESCRIPTION` therefore ends at the
 * next `#`, and holds any `##` beneath it.
 *
 * Headings inside fenced code blocks are not headings. A note explaining
 * markdown, or holding a diff, would otherwise cut its own section short.
 */

/** ```` ``` ```` or `~~~`, opening or closing a fenced code block. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** An ATX heading: up to six hashes, a space, then the title. */
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

type Heading = { line: number; level: number; title: string };

/**
 * Every heading in a body, skipping any that is inside a code fence.
 */
function headingsIn(lines: string[]): Heading[] {
    const headings: Heading[] = [];
    let fence: string | null = null;
    for (const [line, text] of lines.entries()) {
        const fenceMatch = FENCE.exec(text);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (fence === null) {
                fence = marker;
            } else if (fence === marker) {
                fence = null;
            }
            continue;
        }
        if (fence !== null) {
            continue;
        }
        const match = HEADING.exec(text);
        if (match) {
            headings.push({
                line,
                level: match[1].length,
                title: match[2],
            });
        }
    }
    return headings;
}

/**
 * Where a named section starts and ends, as line indices.
 *
 * @returns `[headingLine, endExclusive]`, or null when the note has no such
 * heading.
 */
function locate(lines: string[], name: string): [number, number] | null {
    const headings = headingsIn(lines);
    const index = headings.findIndex((heading) => heading.title === name);
    if (index === -1) {
        return null;
    }
    const section = headings[index];
    const next = headings
        .slice(index + 1)
        .find((heading) => heading.level <= section.level);
    return [section.line, next ? next.line : lines.length];
}

/**
 * Read the contents of a named section.
 *
 * @param body A note's body, everything below its frontmatter.
 * @param name The heading text, without its hashes — `DESCRIPTION`.
 * @returns The text under the heading with surrounding blank lines trimmed, or
 * null when the note has no such heading. Null and `""` are different answers:
 * the first means the section is absent, the second that it is there and empty.
 */
export function readSection(body: string, name: string): string | null {
    const lines = body.split("\n");
    const found = locate(lines, name);
    if (!found) {
        return null;
    }
    const [start, end] = found;
    return lines
        .slice(start + 1, end)
        .join("\n")
        .trim();
}

/**
 * Set the contents of a named section, adding or removing it as needed.
 *
 * The three cases, which are the same three `modifyFrontmatterString` draws for
 * a key:
 *
 * - text with a section already there — the contents are replaced where they
 *   stand, so the section keeps its position in the note;
 * - text with no section — the heading is appended at the end, which is the
 *   only position that cannot displace anything the user arranged;
 * - `""` — the section and its heading are removed entirely. A heading with
 *   nothing under it is not a description someone left blank, it is clutter.
 *
 * @param body A note's body, everything below its frontmatter.
 * @param name The heading text, without its hashes.
 * @param text The new contents. Trimmed; `""` removes the section.
 * @returns The body, with everything outside the section untouched.
 */
export function upsertSection(
    body: string,
    name: string,
    text: string
): string {
    const lines = body.split("\n");
    const found = locate(lines, name);
    const content = text.trim();

    if (!found) {
        if (content === "") {
            return body;
        }
        // A blank line before the heading unless the note is empty, so the
        // section does not run into whatever the last paragraph was.
        const existing = body.replace(/\s+$/, "");
        const prefix = existing === "" ? "" : `${existing}\n\n`;
        return `${prefix}# ${name}\n\n${content}\n`;
    }

    const [start, end] = found;
    const before = lines.slice(0, start);
    const after = lines.slice(end);

    if (content === "") {
        // Drop the blank line the removed section was separated by, so
        // repeatedly clearing a description does not leave a growing gap.
        while (before.length > 0 && before[before.length - 1].trim() === "") {
            before.pop();
        }
        const rest = after.join("\n");
        return before.length === 0
            ? rest.replace(/^\n+/, "")
            : `${before.join("\n")}\n${after.length > 0 ? `\n${rest}` : ""}`;
    }

    // The trailing blank line is unconditional: it separates the section from
    // whatever follows, and ends the body with a newline when nothing does.
    return [
        ...before,
        lines[start],
        "",
        ...content.split("\n"),
        "",
        ...after,
    ].join("\n");
}
