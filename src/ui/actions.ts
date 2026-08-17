import { App, MarkdownView, Notice, TFile, Vault, Workspace } from "obsidian";
import EventCache from "src/core/EventCache";
import {
    skipOccurrence,
    truncateSeriesBefore,
} from "src/calendars/recurrence_edit";
import { promptRecurrenceScope } from "./recurrence_prompt";

/**
 * Open a file in the editor to a given event.
 *
 * Works for any event that came from a note, editable or not: a derived
 * calendar's events point at notes the plugin only reads, and opening one is
 * the main thing you can do with them.
 *
 * @param cache
 * @param param1 App
 * @param id event ID
 * @param split open in a new split rather than reusing the current leaf
 * @returns
 */
export async function openFileForEvent(
    cache: EventCache,
    { workspace, vault }: { workspace: Workspace; vault: Vault },
    id: string,
    split = false
) {
    const details = cache.getInfoForEvent(id);
    if (!details) {
        throw new Error("Event does not have local representation.");
    }
    const {
        location: { path, lineNumber },
    } = details;
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        return;
    }

    let leaf = split
        ? workspace.getLeaf("split")
        : workspace.getMostRecentLeaf();
    if (!leaf) {
        return;
    }
    if (leaf.getViewState().pinned) {
        leaf = workspace.getLeaf("tab");
    }
    await leaf.openFile(file);
    if (lineNumber && leaf.view instanceof MarkdownView) {
        leaf.view.editor.setCursor({ line: lineNumber, ch: 0 });
    }
}

/**
 * Delete an event, asking which occurrences when it repeats.
 *
 * The three answers reach three different places, which is the whole point of
 * the model in PLANNING §3.2:
 *
 * - **This event** appends to the master's `skipDates`. No file is created and
 *   none is removed — a cancelled occurrence is an absence, and an absence is
 *   cheaper as metadata than as a note.
 * - **This and following** caps the master with `until`. If that would leave
 *   the series with nothing in it, the master goes instead: the user truncated
 *   at the first occurrence, which is a request for the series to stop
 *   existing.
 * - **All events** deletes the master, exactly as deleting any other event does.
 *
 * Shared between the context menu and the edit modal so the two cannot drift
 * into answering the same question differently.
 *
 * @param cache Event cache, which mediates every write.
 * @param app Obsidian app, for the prompt.
 * @param eventId ID of the event — for a recurring series this is the master,
 * since every occurrence on screen is one event with a rule.
 * @param occurrence Date of the occurrence the user acted on, from
 * `occurrenceDate`. Ignored for a non-recurring event.
 * @returns Whether anything was deleted. False means the user cancelled, which
 * callers that close a modal on success need to distinguish.
 */
export async function deleteEventWithScope(
    cache: EventCache,
    app: App,
    eventId: string,
    occurrence: string | null
): Promise<boolean> {
    const stored = cache.getEventById(eventId);
    if (!stored) {
        throw new Error(`Event ID ${eventId} is not in the cache.`);
    }

    if (stored.type !== "recurring") {
        await cache.deleteEvent(eventId);
        new Notice(`Deleted "${stored.title}".`);
        return true;
    }

    const scope = await promptRecurrenceScope(app, "delete", stored.title);
    if (scope === null) {
        return false;
    }

    if (scope === "all") {
        await cache.deleteEvent(eventId);
        new Notice(`Deleted every occurrence of "${stored.title}".`);
        return true;
    }

    if (occurrence === null) {
        throw new Error(
            `Cannot delete a single occurrence of "${stored.title}": nothing recorded which occurrence was clicked.`
        );
    }

    if (scope === "this") {
        await cache.processEvent(eventId, (event) =>
            skipOccurrence(event, occurrence)
        );
        new Notice(
            `Deleted the occurrence of "${stored.title}" on ${occurrence}.`
        );
        return true;
    }

    const capped = truncateSeriesBefore(stored, occurrence);
    if (capped === null) {
        await cache.deleteEvent(eventId);
        new Notice(
            `Deleted "${stored.title}": ${occurrence} was its first occurrence, so nothing was left of the series.`
        );
        return true;
    }
    await cache.updateEventWithId(eventId, capped);
    new Notice(`"${stored.title}" now ends before ${occurrence}.`);
    return true;
}
