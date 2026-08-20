import { App, MarkdownView, Notice, TFile, Vault, Workspace } from "obsidian";
import EventCache from "src/core/EventCache";
import { FerryEvent } from "src/types";
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
 * The edit to apply, in the two forms the three answers need.
 *
 * A drag reaches the series and the instance differently and there is no
 * converting one into the other after the fact: moving an occurrence to
 * Wednesday means "this series now falls on Wednesday" under **All events**
 * and "this one note is dated Wednesday" under **This event**, and the rule is
 * only in the first. So the caller, which is the only thing that knows what the
 * user actually did, supplies both.
 */
export type EventEdits = {
    /**
     * The edit as it applies to the whole series, rule moved with it.
     *
     * A function for the same reason `instance` is: moving a series means
     * rewriting its rule, and there are rules that cannot be moved — a
     * hand-written `rrule` among them. Building it eagerly would throw on a
     * drag the user was about to scope to one occurrence, which needs no rule
     * change at all.
     */
    series: () => FerryEvent;
    /**
     * The same edit as one ordinary dated event, for an override note.
     *
     * A function because it is built only when an override is actually made,
     * and building it for an event with no rule left to strip would throw.
     *
     * @param occurrence The date the rule generated the occurrence on. A caller
     * that cannot move an event — the modal — dates the note with it; one that
     * can — a drag — dates the note where the user dropped it and ignores this.
     */
    instance: (occurrence: string) => FerryEvent;
};

/**
 * Apply an edit, asking which occurrences when the event repeats.
 *
 * The counterpart to `deleteEventWithScope`, and the second half of the UI
 * contract in PLANNING §3.2: a drag, resize or save on a recurring instance
 * asks before it writes, because the same gesture means three different things.
 *
 * - **This event** materialises an override note. The master is untouched; the
 *   occurrence it generates stops being drawn because the override says it
 *   replaces it.
 * - **This and following** caps the master and starts a second series at the
 *   edit date.
 * - **All events** writes the edit back to the master, which is what a drag on
 *   a recurring event did before there was a prompt.
 *
 * @param cache Event cache, which mediates every write.
 * @param app Obsidian app, for the prompt.
 * @param eventId ID of the event — the master, for a series.
 * @param occurrence Date of the occurrence the user acted on, from
 * `occurrenceDate`, and for a drag the date it started from rather than the one
 * it landed on. Ignored for an event that does not repeat.
 * @param edits The edit to apply. See `EventEdits`.
 * @returns Whether anything was written. False means the user dismissed the
 * prompt, which a drag has to treat as a revert: the occurrence has already
 * moved on screen.
 */
export async function modifyEventWithScope(
    cache: EventCache,
    app: App,
    eventId: string,
    occurrence: string | null,
    edits: EventEdits
): Promise<boolean> {
    const stored = cache.getEventById(eventId);
    if (!stored) {
        throw new Error(`Event ID ${eventId} is not in the cache.`);
    }

    if (stored.type !== "recurring") {
        await cache.updateEventWithId(eventId, edits.series());
        return true;
    }

    const scope = await promptRecurrenceScope(app, "edit", stored.title);
    if (scope === null) {
        return false;
    }

    if (scope === "all") {
        await cache.updateEventWithId(eventId, edits.series());
        new Notice(`Updated every occurrence of "${stored.title}".`);
        return true;
    }

    if (occurrence === null) {
        throw new Error(
            `Cannot edit a single occurrence of "${stored.title}": nothing recorded which occurrence was clicked.`
        );
    }

    if (scope === "this") {
        await cache.createOverride(
            eventId,
            occurrence,
            edits.instance(occurrence)
        );
        new Notice(
            `The occurrence of "${stored.title}" on ${occurrence} is now its own note.`
        );
        return true;
    }

    await cache.splitSeriesAt(eventId, occurrence, edits.series());
    new Notice(`"${stored.title}" changes from ${occurrence} onwards.`);
    return true;
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
