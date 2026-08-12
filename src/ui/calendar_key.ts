import { CalendarInfo } from "../types";

/**
 * Pure logic behind the calendar key: which calendars are visible, and what
 * each one is called. Kept free of DOM references so it can be tested under
 * jest's node environment; rendering lives in `renderCalendarKey`.
 */

/** The subset of a calendar source the key needs in order to draw a row. */
export type KeyEntry = {
    id: string;
    name: string;
    type: CalendarInfo["type"];
    color: string;
};

/**
 * Whether a calendar's events should be rendered.
 *
 * Visibility is stored as a list of *hidden* ids rather than visible ones, so
 * a calendar the list has never heard of — a newly added one, or one whose id
 * changed when its directory was renamed — defaults to visible. The opposite
 * default could hide a calendar with no row left in the key to unhide it.
 */
export function isCalendarVisible(hidden: string[], id: string): boolean {
    return !hidden.includes(id);
}

/**
 * Apply a toggle, returning a new hidden-list.
 *
 * @param hidden current hidden ids
 * @param id calendar being toggled
 * @param visible desired state — true to show, false to hide
 */
export function setCalendarVisibility(
    hidden: string[],
    id: string,
    visible: boolean
): string[] {
    if (visible) {
        return hidden.filter((h) => h !== id);
    }
    return hidden.includes(id) ? [...hidden] : [...hidden, id];
}

/**
 * Drop hidden ids that no longer match a live calendar.
 *
 * A calendar id is derived from its type and directory/URL, so editing a
 * calendar in settings changes its id and strands the old entry. Without
 * pruning, those entries accumulate in data.json forever, and — worse — a
 * directory renamed away and later renamed back would come back still hidden,
 * long after the user forgot they hid it.
 */
export function pruneHiddenCalendars(
    hidden: string[],
    knownIds: string[]
): string[] {
    const known = new Set(knownIds);
    const seen = new Set<string>();
    return hidden.filter((id) => {
        if (!known.has(id) || seen.has(id)) {
            return false;
        }
        seen.add(id);
        return true;
    });
}

/**
 * A short, human-readable label for a calendar row.
 *
 * A calendar's `name` is whatever identifies it — a directory path, a heading,
 * a URL — and several of those are far too long to sit in a key. This trims
 * them to something readable; callers should show the full `name` as a tooltip
 * so nothing is actually lost.
 */
export function calendarLabel(entry: Pick<KeyEntry, "name" | "type">): string {
    const { name, type } = entry;
    switch (type) {
        case "local":
            // Directory path -> its last segment. "CALENDARS/SOCIAL" -> "SOCIAL".
            return basename(name) || name;
        case "dailynote":
            return name ? `Daily notes: ${name}` : "Daily notes";
        case "ical":
            return hostname(name) || name;
        case "caldav":
            // CalDAV servers supply a display name already.
            return name;
        case "derived":
            // Named by whoever set the mapping up, and one directory can carry
            // several of them, so the name is the only thing that tells two
            // apart.
            return name;
        case "FOR_TEST_ONLY":
            return name;
    }
    // Exhaustiveness guard: a new calendar type must decide how it is labelled
    // rather than silently inheriting a fallback.
    const unreachable: never = type;
    throw new Error(`No calendar key label defined for type '${unreachable}'.`);
}

export type CalendarKeyCallbacks = {
    /** Called when a row is checked or unchecked. */
    onToggle: (id: string, visible: boolean) => void | Promise<void>;
    /** Called when the key itself is opened or closed. */
    onCollapse: (collapsed: boolean) => void | Promise<void>;
};

/**
 * Draw the calendar key: one checkbox row per calendar, inside a collapsible
 * container.
 *
 * Rows are rebuilt from scratch on each call, which is fine at this size — a
 * vault has a handful of calendars, not thousands — and avoids having to
 * reconcile DOM against a changing calendar list.
 *
 * @param parent element to render into; its contents are replaced
 * @param entries one per calendar, in the order they should appear
 * @param hidden ids currently hidden, as stored in settings
 * @param collapsed whether the key starts closed
 */
export function renderCalendarKey(
    parent: HTMLElement,
    entries: KeyEntry[],
    hidden: string[],
    collapsed: boolean,
    { onToggle, onCollapse }: CalendarKeyCallbacks
): void {
    parent.empty();

    // A single calendar still gets a row: turning it off is a legitimate way to
    // clear the view, and a key that appears only once a second calendar exists
    // is more confusing than one that is briefly short.
    if (entries.length === 0) {
        return;
    }

    const details = parent.createEl("details", { cls: "ferry-key" });
    details.open = !collapsed;
    details.addEventListener("toggle", () => void onCollapse(!details.open));

    details.createEl("summary", {
        cls: "ferry-key-summary",
        text: "Calendars",
    });

    const rows = details.createDiv({ cls: "ferry-key-rows" });

    for (const entry of entries) {
        // The full name goes in the tooltip, since the label may be truncated
        // from a long directory path or URL.
        const row = rows.createEl("label", {
            cls: "ferry-key-row",
            title: entry.name,
        });

        const checkbox = row.createEl("input", { cls: "ferry-key-checkbox" });
        checkbox.type = "checkbox";
        checkbox.checked = isCalendarVisible(hidden, entry.id);
        checkbox.addEventListener("change", () =>
            onToggle(entry.id, checkbox.checked)
        );

        const swatch = row.createDiv({ cls: "ferry-key-swatch" });
        swatch.style.backgroundColor = entry.color;

        row.createSpan({
            cls: "ferry-key-label",
            text: calendarLabel(entry),
        });
    }
}

/** Last path segment, ignoring any trailing slashes. */
function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Host portion of a URL.
 *
 * Returns "" rather than throwing when the URL will not parse. A calendar key
 * is cosmetic, and a stored URL that predates validation should not be able to
 * take down the whole calendar view — the caller falls back to the raw value,
 * which is still correct, just longer.
 */
function hostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}
